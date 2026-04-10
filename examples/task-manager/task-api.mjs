/**
 * Task Manager API — the backend service.
 *
 * A proper task management API with full CRUD, search, analytics,
 * and batch operations. The MCP server wraps a subset of this.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TASKS_PATH = join(new URL('.', import.meta.url).pathname, 'tasks.json');

function load() {
  try { return JSON.parse(readFileSync(TASKS_PATH, 'utf-8')); }
  catch { return []; }
}

function save(tasks) {
  writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2) + '\n');
}

function today() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeStatus(status) {
  return status ? status.replace(/_/g, '-') : status;
}

function isOverdue(task) {
  return task.status !== 'completed' && !!task.dueDate && task.dueDate < today();
}

function summarize(task) {
  return {
    id: task.id,
    title: task.title,
    status: normalizeStatus(task.status),
    priority: task.priority,
    assignee: task.assignee,
    dueDate: task.dueDate,
    completedAt: task.completedAt || null,
    isOverdue: isOverdue(task),
    tags: task.tags,
  };
}

// --- Read operations ---

export function listTasks(filters = {}) {
  let tasks = load();

  if (filters.status) {
    // Normalize both filter input and stored value so "in_progress" and "in-progress" both work
    const statuses = filters.status.split(',').map(s => normalizeStatus(s.trim().toLowerCase()));
    const overdueRequested = statuses.includes('overdue');
    const otherStatuses = statuses.filter(s => s !== 'overdue');
    tasks = tasks.filter(t => {
      if (overdueRequested && isOverdue(t)) return true;
      if (otherStatuses.length > 0 && otherStatuses.includes(normalizeStatus(t.status).toLowerCase())) return true;
      return false;
    });
  }
  if (filters.assignee) {
    const assignees = filters.assignee.split(',').map(s => s.trim().toLowerCase());
    tasks = tasks.filter(t => t.assignee && assignees.includes(t.assignee.toLowerCase()));
  }
  if (filters.priority) {
    const priorities = filters.priority.split(',').map(s => s.trim().toLowerCase());
    tasks = tasks.filter(t => t.priority && priorities.includes(t.priority.toLowerCase()));
  }
  if (filters.dueBefore) {
    tasks = tasks.filter(t => t.dueDate && t.dueDate <= filters.dueBefore);
  }
  if (filters.dueAfter) {
    tasks = tasks.filter(t => t.dueDate && t.dueDate >= filters.dueAfter);
  }
  if (filters.completedAfter) {
    tasks = tasks.filter(t => t.completedAt && t.completedAt.slice(0, 10) >= filters.completedAfter);
  }
  if (filters.completedBefore) {
    tasks = tasks.filter(t => t.completedAt && t.completedAt.slice(0, 10) <= filters.completedBefore);
  }
  if (filters.overdue === true) {
    tasks = tasks.filter(t => isOverdue(t));
  } else if (filters.overdue === false) {
    tasks = tasks.filter(t => !isOverdue(t));
  }
  if (filters.tag) {
    const tag = filters.tag.toLowerCase();
    tasks = tasks.filter(t => (t.tags || []).some(tg => tg.toLowerCase() === tag));
  }
  if (filters.unassigned === true) {
    tasks = tasks.filter(t => !t.assignee);
  }

  return { today: today(), count: tasks.length, tasks: tasks.map(summarize) };
}

export function getTask(id) {
  const tasks = load();
  const task = tasks.find(t => t.id === id);
  if (!task) return { error: `Task not found: ${id}`, found: false };
  return { ...task, isOverdue: isOverdue(task), found: true };
}

export function searchTasks(query, filters = {}) {
  let tasks = load();

  if (query) {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    tasks = tasks.filter(t => {
      const title = t.title.toLowerCase();
      const desc = (t.description || '').toLowerCase();
      const tags = (t.tags || []).map(tg => tg.toLowerCase());
      const assignee = (t.assignee || '').toLowerCase();
      return tokens.every(token =>
        title.includes(token) ||
        desc.includes(token) ||
        tags.some(tg => tg.includes(token)) ||
        assignee.includes(token)
      );
    });
  }

  // Apply same filters as listTasks
  if (filters.status) {
    // Normalize both filter input and stored value so "in_progress" and "in-progress" both work
    const statuses = filters.status.split(',').map(s => normalizeStatus(s.trim().toLowerCase()));
    const overdueRequested = statuses.includes('overdue');
    const otherStatuses = statuses.filter(s => s !== 'overdue');
    tasks = tasks.filter(t => {
      if (overdueRequested && isOverdue(t)) return true;
      if (otherStatuses.length > 0 && otherStatuses.includes(normalizeStatus(t.status).toLowerCase())) return true;
      return false;
    });
  }
  if (filters.assignee) {
    const assignees = filters.assignee.split(',').map(s => s.trim().toLowerCase());
    tasks = tasks.filter(t => t.assignee && assignees.includes(t.assignee.toLowerCase()));
  }
  if (filters.priority) {
    tasks = tasks.filter(t => t.priority && t.priority.toLowerCase() === filters.priority.toLowerCase());
  }
  if (filters.dueBefore) {
    tasks = tasks.filter(t => t.dueDate && t.dueDate <= filters.dueBefore);
  }
  if (filters.dueAfter) {
    tasks = tasks.filter(t => t.dueDate && t.dueDate >= filters.dueAfter);
  }

  return { today: today(), count: tasks.length, tasks: tasks.map(summarize) };
}

export function getStats() {
  const tasks = load();
  const now = today();

  const byStatus = {};
  for (const t of tasks) {
    const s = normalizeStatus(t.status);
    byStatus[s] = (byStatus[s] || 0) + 1;
  }

  const overdue = tasks.filter(t => isOverdue(t)).length;
  const completed = byStatus.completed || 0;
  const completionRate = tasks.length > 0 ? (completed / tasks.length * 100).toFixed(1) + '%' : '0%';

  const assigneeCounts = {};
  for (const t of tasks) {
    if (t.assignee) assigneeCounts[t.assignee] = (assigneeCounts[t.assignee] || 0) + 1;
  }
  const topAssignees = Object.entries(assigneeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  return { total: tasks.length, byStatus, overdue, completionRate, topAssignees };
}

// --- Analytics (not exposed by MCP) ---

export function getAssigneeWorkload(assignee) {
  const tasks = load();
  const mine = tasks.filter(t => t.assignee && t.assignee.toLowerCase() === assignee.toLowerCase());

  const byStatus = {};
  for (const t of mine) byStatus[t.status] = (byStatus[t.status] || 0) + 1;

  const overdue = mine.filter(t => isOverdue(t));
  const upcoming = mine.filter(t => {
    if (t.status === 'completed' || !t.dueDate) return false;
    const diff = (new Date(t.dueDate) - new Date(today())) / (1000 * 60 * 60 * 24);
    return diff >= 0 && diff <= 7;
  });

  return {
    assignee,
    total: mine.length,
    byStatus,
    overdue: overdue.map(summarize),
    upcomingThisWeek: upcoming.map(summarize),
  };
}

export function getOverdueSummary() {
  const tasks = load().filter(t => isOverdue(t));

  const byAssignee = {};
  for (const t of tasks) {
    const key = t.assignee || 'unassigned';
    (byAssignee[key] = byAssignee[key] || []).push(summarize(t));
  }

  return { today: today(), totalOverdue: tasks.length, byAssignee };
}

export function getTasksByTag(tag) {
  const tasks = load().filter(t =>
    (t.tags || []).some(tg => tg.toLowerCase() === tag.toLowerCase())
  );
  return { tag, count: tasks.length, tasks: tasks.map(summarize) };
}

export function getTagSummary() {
  const tasks = load();
  const tagCounts = {};
  for (const t of tasks) {
    for (const tag of t.tags || []) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }
  return Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));
}

// --- Write operations ---

export function createTask({ title, description, assignee, dueDate, priority, tags }) {
  const tasks = load();
  const maxNum = tasks.reduce((max, t) => {
    const num = parseInt(t.id.replace(/\D/g, ''), 10);
    return isNaN(num) ? max : Math.max(max, num);
  }, 0);

  const task = {
    id: `task-${String(maxNum + 1).padStart(3, '0')}`,
    title,
    description: description || null,
    status: 'todo',
    priority: priority || 'medium',
    assignee: assignee || null,
    dueDate: dueDate || null,
    tags: tags || [],
    completedAt: null,
    createdAt: new Date().toISOString(),
  };

  tasks.push(task);
  save(tasks);
  return task;
}

export function updateTask(id, changes) {
  const tasks = load();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return { error: `Task not found: ${id}`, found: false };

  const task = tasks[idx];
  for (const [key, val] of Object.entries(changes)) {
    if (val !== undefined) task[key] = val;
  }

  // Handle completedAt lifecycle
  if (changes.status === 'completed' && !task.completedAt) {
    task.completedAt = new Date().toISOString();
  } else if (changes.status && changes.status !== 'completed') {
    task.completedAt = null;
  }

  tasks[idx] = task;
  save(tasks);
  return { ...task, found: true };
}

export function deleteTask(id) {
  const tasks = load();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return { found: false, id };

  tasks.splice(idx, 1);
  save(tasks);
  return { found: true, deleted: true, id };
}

export function bulkUpdate(ids, changes) {
  const tasks = load();
  const results = [];

  for (const id of ids) {
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) {
      results.push({ id, found: false });
      continue;
    }
    const task = tasks[idx];
    for (const [key, val] of Object.entries(changes)) {
      if (val !== undefined) task[key] = val;
    }
    if (changes.status === 'completed' && !task.completedAt) {
      task.completedAt = new Date().toISOString();
    } else if (changes.status && changes.status !== 'completed') {
      task.completedAt = null;
    }
    tasks[idx] = task;
    results.push({ id, found: true, task: summarize(task) });
  }

  save(tasks);
  return { updated: results.filter(r => r.found).length, results };
}

// --- History (in-memory, reset each server start) ---

const history = [];

export function recordChange(taskId, action, changes, by) {
  history.push({
    taskId,
    action,
    changes,
    by: by || 'system',
    timestamp: new Date().toISOString(),
  });
}

export function getHistory(taskId) {
  if (taskId) return history.filter(h => h.taskId === taskId);
  return history.slice(-50);
}
