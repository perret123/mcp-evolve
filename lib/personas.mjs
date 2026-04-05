/**
 * mcp-evolve — Persona engine.
 *
 * Loads personas from config, provides MBTI-based cluster validation
 * and diversity management.
 */

// --- MBTI types reference ---
// Used for persona diversity validation. Each type represents a distinct
// cognitive style that produces different question patterns and edge cases.
//
// Analysts:  INTJ INTP ENTJ ENTP
// Diplomats: INFJ INFP ENFJ ENFP
// Sentinels: ISTJ ISFJ ESTJ ESFJ
// Explorers: ISTP ISFP ESTP ESFP

const ALL_MBTI = [
  'INTJ','INTP','ENTJ','ENTP',
  'INFJ','INFP','ENFJ','ENFP',
  'ISTJ','ISFJ','ESTJ','ESFJ',
  'ISTP','ISFP','ESTP','ESFP',
];

/**
 * Get a persona by ID, or cycle through based on index.
 */
export function getPersona(personas, idOrIndex) {
  if (typeof idOrIndex === 'string') {
    return personas.find(p => p.id === idOrIndex);
  }
  return personas[idOrIndex % personas.length];
}

/**
 * Get all clusters with their personas.
 */
export function getClusters(personas) {
  const clusters = {};
  for (const p of personas) {
    const cluster = p.cluster || p.id;
    if (!clusters[cluster]) clusters[cluster] = [];
    clusters[cluster].push(p);
  }
  return clusters;
}

/**
 * Validate a new persona candidate against existing personas.
 *
 * Rules:
 *   DIFFERENT (no cluster match) → add as new cluster, any MBTI ok
 *   SIMILAR   (same cluster)     → add as substitute, but MBTI must differ
 *   SAME      (identical role)   → reject, merge concerns into existing persona
 *
 * Returns { valid, reason, action, cluster, conflictsWith }
 */
export function validateNewPersona(personas, candidate) {
  const sameCluster = personas.filter(p => p.cluster === candidate.cluster);

  if (sameCluster.length === 0) {
    return { valid: true, action: 'add', cluster: candidate.cluster, reason: 'New cluster' };
  }

  const mbtiConflict = sameCluster.find(p => p.mbti === candidate.mbti);
  if (mbtiConflict) {
    return {
      valid: false,
      action: 'reject',
      cluster: candidate.cluster,
      conflictsWith: mbtiConflict.id,
      reason: `MBTI collision: ${candidate.mbti} already taken by "${mbtiConflict.id}" in cluster "${candidate.cluster}". Pick a different personality type or merge into existing persona.`,
    };
  }

  return {
    valid: true,
    action: 'add-substitute',
    cluster: candidate.cluster,
    reason: `Joins cluster "${candidate.cluster}" as substitute (MBTI ${candidate.mbti} is unique in cluster)`,
  };
}

/**
 * Print the persona map — clusters with MBTI types.
 */
export function printPersonaMap(personas) {
  const clusters = getClusters(personas);
  const lines = ['PERSONA MAP', '═'.repeat(60)];

  for (const [name, members] of Object.entries(clusters)) {
    lines.push(`\n┌─ ${name} ${'─'.repeat(Math.max(0, 50 - name.length))}┐`);
    for (let i = 0; i < members.length; i++) {
      const p = members[i];
      const marker = i === 0 ? '★' : ' ';
      const grp = p.group || 'train';
      lines.push(`│ ${marker} ${p.id.padEnd(20)} ${(p.mbti || '????').padEnd(6)} [${grp}]${' '.repeat(Math.max(0, 19 - grp.length))}│`);
    }
    lines.push(`└${'─'.repeat(54)}┘`);
  }

  const usedTypes = new Set(personas.map(p => p.mbti).filter(Boolean));
  const available = ALL_MBTI.filter(t => !usedTypes.has(t));
  lines.push(`\nUsed: ${[...usedTypes].join(', ')}`);
  lines.push(`Available: ${available.join(', ')}`);

  return lines.join('\n');
}

/**
 * Get personas filtered by group.
 */
export function getPersonasByGroup(personas, group) {
  return personas.filter(p => (p.group || 'train') === group);
}
