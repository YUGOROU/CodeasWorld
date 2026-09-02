# Code as World

ロボットの単眼 RGB 観測と言語指示から、実行可能な Three.js の世界コードを生成・検査する研究プロトタイプです。

- bounded agent harness と再描画
- 実行済み scene graph の抽出と制約付き MuJoCo への投影
- model-public 観測と evaluator-private 証拠の分離
- pairwise evaluator の契約と fixture sanity check

教師選定、学習品質、Robot Action ranking、実機実行は未成立です。
