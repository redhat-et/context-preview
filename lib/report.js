export function estimateTokens(text) {
  return Math.ceil(Array.from(String(text)).length / 4)
}

export function parseAvailableSkills(system) {
  const text = Array.isArray(system) ? system.join("\n") : String(system ?? "")
  const section = text.match(/<available_skills>([\s\S]*?)<\/available_skills>/)
  if (!section) return /No skills are currently available\./.test(text) ? [] : undefined

  const skills = []
  const pattern = /<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>/g
  for (const match of section[1].matchAll(pattern)) {
    const name = match[1]?.trim()
    const description = match[2]?.trim()
    if (name && description) skills.push({ name, description })
  }
  return skills
}

function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed[0]
  const last = trimmed.at(-1)
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseSkillMarkdown(markdown, fallbackName) {
  const source = String(markdown)
  const opening = source.match(/^\uFEFF?---\s*\r?\n/)
  if (!opening) return undefined
  const frontmatterStart = opening[0].length
  const endMatch = /\r?\n---\s*(?:\r?\n|$)/g
  endMatch.lastIndex = frontmatterStart
  const closing = endMatch.exec(source)
  if (!closing) return undefined

  const lines = source.slice(frontmatterStart, closing.index).split(/\r?\n/)
  const fields = new Map()
  for (let index = 0; index < lines.length; index += 1) {
    const field = lines[index].match(/^([a-zA-Z][\w-]*):\s*(.*)$/)
    if (!field) continue
    const [, key, rawValue] = field
    if (rawValue === "|" || rawValue === ">" || rawValue === "|-" || rawValue === ">-") {
      const block = []
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        block.push(lines[index + 1].trim())
        index += 1
      }
      fields.set(key, block.join(rawValue.startsWith(">") ? " " : "\n").trim())
      continue
    }
    fields.set(key, unquote(rawValue))
  }

  const name = fields.get("name") || fallbackName
  const description = fields.get("description")
  if (
    !name ||
    name !== fallbackName ||
    name.length > 64 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
    !description ||
    description.length > 1024
  ) {
    return undefined
  }
  return { name, description }
}

function matches(pattern, name) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")
  return new RegExp(`^${escaped}$`).test(name)
}

export function isSkillAllowed(name, permission) {
  if (!permission || typeof permission !== "object") return true
  const rules = Object.entries(permission)
    .filter(([pattern]) => matches(pattern, name))
    .sort(([a], [b]) => b.length - a.length)
  return rules[0]?.[1] !== "deny"
}

export function formatReport(report) {
  const lines = [
    "OpenCode context preview",
    `Active MCP servers: ${report.mcpServers.length}; skills: ~${report.totals.skillTokens} tokens`,
    `Generated: ${report.generatedAt}`,
    "",
    "Active MCP servers:",
  ]

  if (report.mcpServers.length === 0) lines.push("  (none active or connected)")
  for (const server of report.mcpServers) {
    lines.push(`  ${server.name} [${server.status}]`)
  }

  lines.push("", "Available skills (name and description):")
  if (report.skills.length === 0) {
    lines.push("  (none found)")
    if (report.skillSearchPaths?.length) lines.push(`  Searched: ${report.skillSearchPaths.join(", ")}`)
  }
  for (const skill of report.skills) {
    lines.push(`  ${skill.name}: ~${skill.estimatedTokens} tokens [${skill.source}]`)
    lines.push(`    ${skill.description}`)
  }
  lines.push("", report.estimateMethod)
  return lines.join("\n")
}

export function formatToast(report) {
  const items = [
    ...report.mcpServers.map((server) => ({
      label: `MCP ${server.name}`,
      value: server.status,
    })),
    ...report.skills.map((skill) => ({ label: `Skill ${skill.name}`, value: `~${skill.estimatedTokens} tokens` })),
  ]
  const lines = [
    `${report.mcpServers.length} active MCP server(s); ~${report.totals.skillTokens} skill description tokens`,
  ]
  for (const item of items) lines.push(`${item.label}: ${item.value}`)
  lines.push("", "Toggle these on & off with /mcp or /skill-toggle")
  return lines.join("\n")
}
