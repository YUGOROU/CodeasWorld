"""Constrained Three.js scene extraction to MuJoCo projection and probe rollout."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
import math
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET


EXTRACTED_SCHEMA = "codeasworld-extracted-scene-v1"
PROJECTION_SCHEMA = "codeasworld-mujoco-projection-v1"
ROLLOUT_SCHEMA = "codeasworld-deterministic-rollout-v1"
SUPPORTED_GEOMETRIES = {"BoxGeometry", "SphereGeometry", "CylinderGeometry", "asset"}
PHYSICS_CLASSES = {"static", "dynamic", "ignored"}


class ProjectionError(ValueError):
    """A fail-closed scene-contract or projection error."""


def _bounded_vector(value: Any, length: int, field: str, limit: float = 100.0) -> list[float]:
    if not isinstance(value, list) or len(value) != length:
        raise ProjectionError(f"{field} must contain {length} numbers")
    result: list[float] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item) or abs(item) > limit:
            raise ProjectionError(f"{field} contains an invalid number")
        result.append(float(item))
    return result


def validate_extracted_scene(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema_version") != EXTRACTED_SCHEMA:
        raise ProjectionError("unsupported extracted scene schema")
    if value.get("units") != "meter":
        raise ProjectionError("extracted scene units must be meter")
    entities = value.get("entities")
    if not isinstance(entities, list):
        raise ProjectionError("entities must be a list")
    seen: set[str] = set()
    for index, entity in enumerate(entities):
        if not isinstance(entity, dict):
            raise ProjectionError(f"entities[{index}] must be an object")
        entity_id = entity.get("id")
        if not isinstance(entity_id, str) or not entity_id or len(entity_id) > 128 or entity_id in seen:
            raise ProjectionError(f"entities[{index}].id is invalid or duplicated")
        seen.add(entity_id)
        if entity.get("physics") not in PHYSICS_CLASSES:
            raise ProjectionError(f"{entity_id}: unsupported physics class")
        transform = entity.get("transform")
        if not isinstance(transform, dict):
            raise ProjectionError(f"{entity_id}: transform is required")
        _bounded_vector(transform.get("position"), 3, f"{entity_id}.position")
        quaternion = _bounded_vector(transform.get("quaternion_xyzw"), 4, f"{entity_id}.quaternion", 1.0)
        if abs(sum(item * item for item in quaternion) - 1.0) > 1e-4:
            raise ProjectionError(f"{entity_id}: quaternion must be normalized")
        scale = _bounded_vector(transform.get("scale"), 3, f"{entity_id}.scale")
        if any(item <= 0 for item in scale):
            raise ProjectionError(f"{entity_id}: scale must be positive")
        geometry = entity.get("geometry")
        if not isinstance(geometry, dict) or geometry.get("type") not in SUPPORTED_GEOMETRIES:
            raise ProjectionError(f"{entity_id}: unsupported geometry")
        _bounded_vector(geometry.get("bounding_size"), 3, f"{entity_id}.bounding_size")
    return value


def _fmt(values: list[float]) -> str:
    return " ".join(f"{value:.9g}" for value in values)


def _position_three_to_mujoco(position: list[float]) -> list[float]:
    return [position[0], -position[2], position[1]]


def _quaternion_three_to_mujoco(quaternion_xyzw: list[float]) -> list[float]:
    # Coordinate basis B maps Three.js (x,y,z) to MuJoCo (x,-z,y).
    x, y, z, w = quaternion_xyzw
    rotation = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
    basis = [[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]]
    def multiply(left: list[list[float]], right: list[list[float]]) -> list[list[float]]:
        return [[sum(left[row][k] * right[k][column] for k in range(3)) for column in range(3)] for row in range(3)]
    mapped = multiply(multiply(basis, rotation), [list(column) for column in zip(*basis)])
    trace = mapped[0][0] + mapped[1][1] + mapped[2][2]
    if trace > 0:
        scale = math.sqrt(trace + 1.0) * 2
        qw = 0.25 * scale
        qx = (mapped[2][1] - mapped[1][2]) / scale
        qy = (mapped[0][2] - mapped[2][0]) / scale
        qz = (mapped[1][0] - mapped[0][1]) / scale
    else:
        index = max(range(3), key=lambda item: mapped[item][item])
        if index == 0:
            scale = math.sqrt(1.0 + mapped[0][0] - mapped[1][1] - mapped[2][2]) * 2
            qw, qx, qy, qz = (mapped[2][1] - mapped[1][2]) / scale, 0.25 * scale, (mapped[0][1] + mapped[1][0]) / scale, (mapped[0][2] + mapped[2][0]) / scale
        elif index == 1:
            scale = math.sqrt(1.0 + mapped[1][1] - mapped[0][0] - mapped[2][2]) * 2
            qw, qx, qy, qz = (mapped[0][2] - mapped[2][0]) / scale, (mapped[0][1] + mapped[1][0]) / scale, 0.25 * scale, (mapped[1][2] + mapped[2][1]) / scale
        else:
            scale = math.sqrt(1.0 + mapped[2][2] - mapped[0][0] - mapped[1][1]) * 2
            qw, qx, qy, qz = (mapped[1][0] - mapped[0][1]) / scale, (mapped[0][2] + mapped[2][0]) / scale, (mapped[1][2] + mapped[2][1]) / scale, 0.25 * scale
    return [qw, qx, qy, qz]


def _geom_attributes(entity: dict[str, Any], warnings: list[dict[str, str]]) -> dict[str, str]:
    geometry = entity["geometry"]
    kind = geometry["type"]
    if kind == "BoxGeometry":
        size = _bounded_vector(geometry.get("size"), 3, f"{entity['id']}.size")
        return {"type": "box", "size": _fmt([size[0] / 2, size[2] / 2, size[1] / 2])}
    if kind == "SphereGeometry":
        radius = geometry.get("radius")
        if not isinstance(radius, (int, float)) or isinstance(radius, bool) or radius <= 0:
            raise ProjectionError(f"{entity['id']}: sphere radius is invalid")
        return {"type": "sphere", "size": _fmt([float(radius)])}
    if kind == "CylinderGeometry":
        radius, height = geometry.get("radius"), geometry.get("height")
        if any(not isinstance(item, (int, float)) or isinstance(item, bool) or item <= 0 for item in (radius, height)):
            raise ProjectionError(f"{entity['id']}: cylinder dimensions are invalid")
        return {"type": "cylinder", "size": _fmt([float(radius), float(height) / 2])}
    bounds = _bounded_vector(geometry.get("bounding_size"), 3, f"{entity['id']}.bounding_size")
    if any(item <= 0 for item in bounds):
        raise ProjectionError(f"{entity['id']}: asset bounding box must be positive")
    warnings.append({"entity_id": entity["id"], "code": "ASSET_BOX_APPROXIMATION"})
    return {"type": "box", "size": _fmt([bounds[0] / 2, bounds[2] / 2, bounds[1] / 2])}


def project_scene_to_mjcf(scene: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    validate_extracted_scene(scene)
    root = ET.Element("mujoco", {"model": "codeasworld_vertical_slice"})
    ET.SubElement(root, "option", {"timestep": "0.01", "integrator": "implicitfast", "gravity": "0 0 -9.81"})
    worldbody = ET.SubElement(root, "worldbody")
    warnings: list[dict[str, str]] = []
    projected: list[str] = []
    for entity in scene["entities"]:
        if entity["physics"] == "ignored":
            continue
        attributes = _geom_attributes(entity, warnings)
        attributes.update({
            "name": f"caw_{entity['id']}",
            "pos": _fmt(_position_three_to_mujoco(entity["transform"]["position"])),
            "quat": _fmt(_quaternion_three_to_mujoco(entity["transform"]["quaternion_xyzw"])),
            "friction": "0.8 0.005 0.0001",
        })
        if entity["physics"] == "static":
            ET.SubElement(worldbody, "geom", attributes)
        else:
            body = ET.SubElement(worldbody, "body", {"name": f"body_{entity['id']}", "pos": attributes.pop("pos"), "quat": attributes.pop("quat")})
            ET.SubElement(body, "freejoint", {"name": f"free_{entity['id']}"})
            attributes["mass"] = "0.1"
            ET.SubElement(body, "geom", attributes)
        projected.append(entity["id"])
    robot = ET.SubElement(worldbody, "body", {"name": "caw_fixed_probe_base", "pos": "-0.35 0 0.05"})
    ET.SubElement(robot, "geom", {"name": "probe_base", "type": "cylinder", "size": "0.05 0.05", "mass": "1", "rgba": "0.2 0.2 0.25 1"})
    link = ET.SubElement(robot, "body", {"name": "caw_fixed_probe_link", "pos": "0 0 0.05"})
    ET.SubElement(link, "joint", {"name": "probe_hinge", "type": "hinge", "axis": "0 0 1", "range": "-1.2 1.2", "damping": "0.1"})
    ET.SubElement(link, "geom", {"name": "probe_link_geom", "type": "capsule", "fromto": "0 0 0 0.3 0 0", "size": "0.02", "mass": "0.2", "rgba": "0.2 0.5 0.8 1"})
    actuator = ET.SubElement(root, "actuator")
    ET.SubElement(actuator, "position", {"name": "probe_position", "joint": "probe_hinge", "kp": "10", "ctrlrange": "-1.2 1.2"})
    xml = ET.tostring(root, encoding="unicode") + "\n"
    report = {
        "schema_version": PROJECTION_SCHEMA,
        "source_scene_sha256": scene.get("source", {}).get("scene_code_sha256"),
        "mjcf_sha256": sha256(xml.encode()).hexdigest(),
        "coordinate_contract": {"three": "right-handed +Y up", "mujoco": "right-handed +Z up", "mapping": "(x,y,z)->(x,-z,y)"},
        "robot": {"id": "caw-fixed-probe-arm-v1", "kind": "simulation-only-1dof", "real_robot_ready": False},
        "projected_entity_ids": projected,
        "warnings": warnings,
    }
    return xml, report


def run_deterministic_rollout(xml: str, *, control: float = 0.35, steps: int = 20) -> dict[str, Any]:
    if not math.isfinite(control) or abs(control) > 1.2 or not 1 <= steps <= 1000:
        raise ProjectionError("rollout action is outside the fixed safety envelope")
    try:
        import mujoco
    except ImportError as error:
        raise RuntimeError("MuJoCo is required for rollout; install the simulation extra") from error
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    initial_qpos = data.qpos.copy().tolist()
    data.ctrl[0] = control
    for _ in range(steps):
        mujoco.mj_step(model, data)
    return {
        "schema_version": ROLLOUT_SCHEMA,
        "engine": {"name": "mujoco", "version": mujoco.__version__},
        "robot": {"id": "caw-fixed-probe-arm-v1", "real_robot_ready": False},
        "action": {"actuator": "probe_position", "control": control, "steps": steps, "timestep": float(model.opt.timestep)},
        "initial_qpos": initial_qpos,
        "final_qpos": data.qpos.copy().tolist(),
        "final_qvel": data.qvel.copy().tolist(),
        "contacts": int(data.ncon),
    }


def artifact_sha256(value: dict[str, Any]) -> str:
    return sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
