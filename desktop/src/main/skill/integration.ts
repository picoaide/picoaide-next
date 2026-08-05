// Skill → engine integration helpers (used by index.ts tool registry).
import { listInstalledSkills } from './installer'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'

export { listInstalledSkills }

// loadSkillInstruction returns the SKILL.md instruction text for a skill.
export function loadSkillInstruction(skillsDir: string, name: string): string | null {
  const p = join(skillsDir, name, 'SKILL.md')
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf8')
}
