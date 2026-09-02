import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

export const name = 'caw-startup'
export const inject = ['cmdlineArgs']

function command() {
  return new Command()
    .name('dsh --profile caw')
    .description('Run one Code as World scene-reconstruction episode.')
    .helpOption('-h, --help', 'show this help')
    .requiredOption('--image <path>', 'original input image')
    .argument('[instruction...]', 'scene reconstruction instruction')
}

export function apply(ctx) {
  const program = command()
  program.action((instructionParts, options) => {
    const instruction = instructionParts.join(' ').trim()
    if (instruction === '') program.error('error: an instruction is required')
    ctx.provide('cawStartup', {
      imagePath: options.image,
      instruction,
    })
  })
  parseCmdline(ctx, program)
}
