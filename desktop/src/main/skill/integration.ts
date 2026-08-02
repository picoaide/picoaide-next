// Skill → engine integration helpers (used by index.ts tool registry).
import { listInstalledSkills } from './installer'
import { load } from './loader'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'

export { listInstalledSkills }

// loadSkillInstruction returns the SKILL.md instruction text for a skill.
export function loadSkillInstruction(skillsDir: string, name: string): string | null {
  const p = join(skillsDir, name, 'SKILL.md')
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf8')
}

// loadSkillEntries returns loaded skills {name, instruction, entrypoint}.
export function loadSkillEntries(skillsDir: string): { name: string; instruction: string; entrypoint: string }[] {
  const installed = listInstalledSkills(() => null)
  const out: { name: string; instruction: string; entrypoint: string }[] = []
  for (const name of Object.keys(installed)) {
    try {
      const loaded = load(skillsDir, name)
      out.push({ name, instruction: loaded.instruction, entrypoint: loaded.entrypoint })
    } catch {
      // broken skill: skip, do not break the registry
    }
  }
  return out
}
