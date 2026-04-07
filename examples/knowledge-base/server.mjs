#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DOCS_PATH = join(new URL('.', import.meta.url).pathname, 'docs.json');

function loadDocs() {
  try {
    return JSON.parse(readFileSync(DOCS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function saveDocs(docs) {
  writeFileSync(DOCS_PATH, JSON.stringify(docs, null, 2) + '\n');
}

const server = new McpServer({
  name: 'knowledge-base',
  version: '0.1.0',
}, {
  instructions: `EvolveCorp's internal knowledge base. Tools for managing corporate documentation, SOPs, and policies.

Read tools: list_pages, read_page, search_docs, get_stats
Write tools: create_page, update_page, delete_page
`,
});

server.tool(
  'list_pages',
  'List documentation pages, optionally filtered by category (e.g., HR, Engineering, Security). Returns summaries (id, title, category, lastModified).',
  {
    category: z.string().optional().describe('Filter by category name.'),
  },
  async ({ category }) => {
    let docs = loadDocs();
    if (category) {
      docs = docs.filter(d => d.category.toLowerCase() === category.toLowerCase());
    }

    const summaries = docs.map(d => ({
      id: d.id,
      title: d.title,
      category: d.category,
      lastModified: d.lastModified,
    }));

    return { content: [{ type: 'text', text: JSON.stringify({ total: summaries.length, pages: summaries }, null, 2) }] };
  },
);

server.tool(
  'read_page',
  'Get the full content of a documentation page by its ID.',
  { id: z.string().describe('Page ID (e.g., "doc-001")') },
  async ({ id }) => {
    const docs = loadDocs();
    const doc = docs.find(d => d.id === id);
    
    if (!doc) {
      return { content: [{ type: 'text', text: JSON.stringify(null) }] };
    }
    
    return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
  },
);

server.tool(
  'search_docs',
  'Search documentation by keyword across titles and content.',
  { query: z.string().describe('Search keyword.') },
  async ({ query }) => {
    const docs = loadDocs();
    
    const matches = docs.filter(d => 
      d.title.includes(query) || 
      d.content.includes(query)
    );

    const summaries = matches.map(d => ({
      id: d.id,
      title: d.title,
      category: d.category,
    }));

    return { content: [{ type: 'text', text: JSON.stringify({ results: summaries.length, matches: summaries }, null, 2) }] };
  },
);

server.tool(
  'get_stats',
  'Get counts of pages by category and total document count.',
  {},
  async () => {
    const docs = loadDocs();
    const byCategory = {};
    for (const d of docs) {
      byCategory[d.category] = (byCategory[d.category] || 0) + 1;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          totalDocuments: docs.length,
          categories: byCategory,
        }, null, 2),
      }],
    };
  },
);

server.tool(
  'create_page',
  'Create a new documentation page.',
  {
    title: z.string().describe('Page title'),
    content: z.string().describe('Page content (markdown)'),
    category: z.string().describe('Category (e.g., HR, Engineering)'),
  },
  async ({ title, content, category }) => {
    const docs = loadDocs();
    const id = `doc-${String(docs.length + 1).padStart(3, '0')}`;
    const now = new Date().toISOString();
    
    const newDoc = {
      id,
      title,
      content,
      category,
      createdAt: now,
      lastModified: now,
    };

    docs.push(newDoc);
    saveDocs(docs);

    return { content: [{ type: 'text', text: JSON.stringify(newDoc, null, 2) }] };
  },
);

server.tool(
  'update_page',
  'Update an existing documentation page.',
  {
    id: z.string().describe('ID of page to update'),
    title: z.string().optional().describe('New title'),
    content: z.string().optional().describe('New content'),
  },
  async ({ id, title, content }) => {
    const docs = loadDocs();
    const idx = docs.findIndex(d => d.id === id);

    if (idx === -1) {
      return { content: [{ type: 'text', text: `Document not found: ${id}` }], isError: true };
    }

    if (title !== undefined) docs[idx].title = title;
    if (content !== undefined) docs[idx].content = content;

    saveDocs(docs);

    return { content: [{ type: 'text', text: JSON.stringify(docs[idx], null, 2) }] };
  },
);

server.tool(
  'delete_page',
  'Permanently delete a document.',
  { id: z.string().describe('ID of page to delete') },
  async ({ id }) => {
    const docs = loadDocs();
    const filtered = docs.filter(d => d.id !== id);
    if (filtered.length === docs.length) {
      return { content: [{ type: 'text', text: `Document not found: ${id}` }], isError: true };
    }
    saveDocs(filtered);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, id }) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
