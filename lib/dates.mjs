const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeTimeZone(timeZone) {
  if (!timeZone) {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  try {
    Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return 'UTC';
  }
}

function buildRelativeDateRule(nextWeekdayMode) {
  if (nextWeekdayMode === 'following-week') {
    return '"next <weekday>" skips the rest of the current week when that weekday is still ahead. Example: Monday -> next Friday = the Friday of the following week.';
  }
  return '"next <weekday>" means the nearest upcoming occurrence of that weekday.';
}

function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  });

  const parts = formatter.formatToParts(date);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const weekdayName = byType.weekday;

  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    weekdayName,
    weekdayIndex: WEEKDAYS.indexOf(weekdayName.toLowerCase()),
  };
}

function formatDateOnly(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function formatWeekday(epochMs) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
  }).format(new Date(epochMs));
}

function resolveWeekdayOffset(modifier, targetIndex, currentIndex, nextWeekdayMode) {
  let delta = targetIndex - currentIndex;

  if (modifier === 'this') {
    return delta < 0 ? delta + 7 : delta;
  }

  if (nextWeekdayMode === 'following-week' && delta > 0) {
    return delta + 7;
  }

  return delta <= 0 ? delta + 7 : delta;
}

function pushResolvedPhrase(resolvedPhrases, seen, phrase, epochMs) {
  const key = phrase.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  resolvedPhrases.push({
    phrase,
    resolvedDate: formatDateOnly(epochMs),
    resolvedWeekday: formatWeekday(epochMs),
  });
}

export function buildRunDateContext(config = {}) {
  const rawReferenceNow = config.referenceNow ? new Date(config.referenceNow) : new Date();
  const referenceNow = Number.isNaN(rawReferenceNow.getTime()) ? new Date() : rawReferenceNow;
  const timeZone = normalizeTimeZone(config.timeZone);
  const nextWeekdayMode = config.nextWeekdayMode === 'following-week'
    ? 'following-week'
    : 'nearest-upcoming';
  const zoned = getZonedParts(referenceNow, timeZone);

  return {
    referenceTime: referenceNow.toISOString(),
    timeZone,
    currentDate: [
      zoned.year,
      String(zoned.month).padStart(2, '0'),
      String(zoned.day).padStart(2, '0'),
    ].join('-'),
    currentWeekday: zoned.weekdayName,
    nextWeekdayMode,
    relativeDateRules: config.relativeDateRules || buildRelativeDateRule(nextWeekdayMode),
  };
}

export function resolvePromptDateContext(promptText, runDateContext) {
  const zoned = getZonedParts(new Date(runDateContext.referenceTime), runDateContext.timeZone);
  const baseEpoch = Date.UTC(zoned.year, zoned.month - 1, zoned.day);
  const resolvedPhrases = [];
  const seen = new Set();

  for (const match of promptText.matchAll(/\b(today|tomorrow|yesterday)\b/gi)) {
    const phrase = match[0];
    const lower = phrase.toLowerCase();
    const delta = lower === 'tomorrow' ? 1 : lower === 'yesterday' ? -1 : 0;
    pushResolvedPhrase(resolvedPhrases, seen, phrase, baseEpoch + delta * DAY_MS);
  }

  for (const match of promptText.matchAll(/\b(this|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi)) {
    const phrase = match[0];
    const modifier = match[1].toLowerCase();
    const targetIndex = WEEKDAYS.indexOf(match[2].toLowerCase());
    const delta = resolveWeekdayOffset(
      modifier,
      targetIndex,
      zoned.weekdayIndex,
      runDateContext.nextWeekdayMode,
    );
    pushResolvedPhrase(resolvedPhrases, seen, phrase, baseEpoch + delta * DAY_MS);
  }

  return {
    ...runDateContext,
    resolvedPhrases,
  };
}

export function formatDateContextForPrompt(dateContext) {
  const lines = [
    `Reference time: ${dateContext.referenceTime}`,
    `Timezone: ${dateContext.timeZone}`,
    `Current local date: ${dateContext.currentDate} (${dateContext.currentWeekday})`,
    `Next-weekday mode: ${dateContext.nextWeekdayMode}`,
    `Relative date rules: ${dateContext.relativeDateRules}`,
  ];

  if (dateContext.resolvedPhrases?.length > 0) {
    lines.push('Resolved relative dates in this prompt:');
    for (const item of dateContext.resolvedPhrases) {
      lines.push(`- "${item.phrase}" -> ${item.resolvedDate} (${item.resolvedWeekday})`);
    }
  }

  return lines.join('\n');
}
