#!/usr/bin/env node
/**
 * Prism CLI 入口（bin: prism）。
 * 零框架：node:util.parseArgs 解析；命令实现见 src/commands/。
 */
import { runCommand, defaultContext } from './argv.js'

process.exitCode = await runCommand(defaultContext(), process.argv.slice(2))
