/**
 * mcp-evolve config for Pubman — Swiss restaurant POS platform.
 *
 * This is the original system that mcp-evolve was built for.
 * It demonstrates all features: prefetch, MBTI personas, debug logs, etc.
 */

import { join } from 'node:path';

// Assumes this runs from the pubmanager repo root
const REPO_ROOT = process.cwd();

export default {
  mcpConfig: './mcp-evolve.json',
  mcpToolPrefix: 'mcp__pubman-local__',
  answererTools: 'mcp__pubman-local__*',

  systemDescription: 'the Pubman restaurant POS platform — a Swiss restaurant management system with table management, ordering, payments, daily turnover reports, staff management, and customer-facing features',

  srcDirs: [
    'packages/pubman-mcp/src',
    'functions/lib/api',
  ],

  knowledgeDir: 'knowledge',

  buildCommand: 'npm run build',
  buildCwd: join(REPO_ROOT, 'packages', 'pubman-mcp'),

  writeTools: [
    'create_guest_products', 'create_transaction', 'create_guest_payment',
    'manage_guest', 'transfer_products', 'delete_guest_product', 'guest_goes',
    'accept_order', 'reject_order', 'create_or_update_order', 'cancel_transaction',
    'cancel_fast_book', 'finalize_daily_turnover', 'create_business',
    'delete_guest_payment', 'dismiss_extraction', 'import_extracted_data',
    'start_extraction', 'restore_cancelled_transaction',
  ],

  questionsPerPersona: 3,
  language: 'English',

  debugLogFiles: [
    join(REPO_ROOT, 'firestore-debug.log'),
    join(REPO_ROOT, 'pubsub-debug.log'),
  ],

  /**
   * Pre-fetch real menu data and table layout from the emulator
   * so question generation uses actual product names.
   */
  prefetch: async (claude, config) => {
    const output = await claude(
      [
        'Call list_businesses to get the business ID.',
        'Then call IN PARALLEL:',
        '1. get_menu_data with search for: "Bier", "Schnitzel", "Kaffee", "Wasser", "Wein", "Salat"',
        '2. get_floor_status (includeGuests: false) to get table names and IDs',
      ].join(' '),
      {
        mcpConfig: config.mcpConfig,
        strictMcpConfig: true,
        disableBuiltinTools: true,
        allowedTools: config.answererTools,
        model: 'haiku',
        outputFormat: 'stream-json',
        verbose: true,
        timeout: 60_000,
      },
    );

    // Parse stream-json for product data
    const products = [];
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        let contents = [];
        if (event.type === 'tool_result' && typeof event.content === 'string') contents.push(event.content);
        if (event.tool_use_result) {
          const tur = event.tool_use_result;
          if (typeof tur === 'string') contents.push(tur);
          else if (Array.isArray(tur)) for (const item of tur) if (item.text) contents.push(item.text);
        }
        if (event.type === 'user' && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block.type === 'tool_result') {
              if (typeof block.content === 'string') contents.push(block.content);
              else if (Array.isArray(block.content)) for (const item of block.content) if (item.text) contents.push(item.text);
            }
          }
        }
        for (const content of contents) {
          const tableRows = content.matchAll(/\|\s*([^|]+?)\s*\|\s*(CHF\s*[\d.,]+)\s*\|\s*([^|]*?)\s*\|/g);
          for (const m of tableRows) {
            const name = m[1].trim();
            if (name && !name.includes('---') && name !== 'Product' && !name.startsWith('_')) {
              products.push(`- ${name} (${m[2].trim()}, ${m[3].trim()})`);
            }
          }
        }
      } catch { /* not JSON */ }
    }

    return products.length > 0
      ? [...new Set(products)].slice(0, 30).join('\n')
      : '';
  },

  personas: [
    {
      id: 'owner',
      group: 'train',
      name: 'Restaurant Owner',
      role: 'Admin',
      mbti: 'ENTJ',
      cluster: 'management',
      description: `You are Hans, the owner of "Gasthaus zum Löwen", a traditional Swiss restaurant in Zürich with 60 seats. You have 8 employees. You're tech-savvy but busy — you want quick answers about business performance.`,
      concerns: [
        'Daily and monthly revenue',
        'Staff performance and sales per employee',
        'Top-selling products and underperformers',
        'Daily turnover reports',
        'Business configuration and settings',
      ],
      questionStyle: 'Direct and results-oriented. Asks about numbers, trends, and comparisons.',
    },
    {
      id: 'floor-manager',
      group: 'train',
      name: 'Floor Manager',
      role: 'LocationManager',
      mbti: 'ESTJ',
      cluster: 'operations',
      description: `You are Sarah, the floor manager during Friday evening service. You manage tables, guest flow, and coordinate between kitchen and waitstaff.`,
      concerns: [
        'Current table occupancy',
        'Active guests and their status',
        'Pending orders',
        'Reservations for tonight',
        'Moving guests between tables',
      ],
      questionStyle: 'Urgent and operational. Asks about current state.',
    },
    {
      id: 'waiter-orders',
      group: 'train',
      name: 'Waiter (Taking Orders)',
      role: 'Service',
      mbti: 'ISTP',
      cluster: 'service',
      description: `You are Marco, a waiter during dinner service. You add products to guest bills and speak in direct commands.`,
      concerns: [
        'Adding products to a table/guest',
        'Creating a new guest and adding products',
        'Checking product availability and prices',
      ],
      questionStyle: 'Direct commands. "Add 3 Espresso to table 2." Always specifies quantities and table/guest.',
    },
    {
      id: 'waiter-payments',
      group: 'eval',
      name: 'Waiter (Payments)',
      role: 'Service',
      mbti: 'ISFJ',
      cluster: 'service',
      description: `You are Sofia, a waitress handling checkouts. Guests want to pay and leave.`,
      concerns: [
        'Checking guest bill totals',
        'Processing cash or card payments',
        'Splitting bills',
        'Handling tips',
      ],
      questionStyle: 'Short commands. "Cash out table 3." "What does table 5 owe?"',
    },
    {
      id: 'waiter-management',
      group: 'eval',
      name: 'Waiter (Guest Management)',
      role: 'Service',
      mbti: 'ENFJ',
      cluster: 'service',
      description: `You are Luca, a senior waiter who manages seating, moves guests, and handles table transfers.`,
      concerns: [
        'Moving guests between tables',
        'Transferring products between guests',
        'Removing wrong items',
        'Marking guests as departed',
      ],
      questionStyle: 'Direct operational commands.',
    },
    {
      id: 'chef',
      group: 'train',
      name: 'Kitchen Chef',
      role: 'Service',
      mbti: 'ISTJ',
      cluster: 'kitchen',
      description: `You are Lucia, the head chef. You manage the prep queue and need to know what's coming in.`,
      concerns: [
        'Current prep queue',
        'Order details',
        'Product catalog and categories',
        'How prep locations are configured',
      ],
      questionStyle: 'Kitchen workflow focused.',
    },
    {
      id: 'accountant',
      group: 'train',
      name: 'Accountant',
      role: 'ReportViewer',
      mbti: 'INTJ',
      cluster: 'finance',
      description: `You are Thomas, the external accountant who reviews finances monthly. You work with precise numbers and date ranges.`,
      concerns: [
        'Transaction history for date ranges',
        'Daily turnover summaries',
        'Revenue by payment method',
        'Tax breakdowns',
        'Voucher balances',
      ],
      questionStyle: 'Precise and analytical. Always specifies dates, wants breakdowns.',
    },
    {
      id: 'new-employee',
      group: 'eval',
      name: 'New Employee',
      role: 'Service',
      mbti: 'ENFP',
      cluster: 'learning',
      description: `You are Nadia, a new waitress on your second day, learning the system.`,
      concerns: [
        'Understanding basic concepts',
        'How to take an order',
        'What a daily turnover is',
        'How payments work',
      ],
      questionStyle: 'Curious. Asks "what is..." and "how do I..." questions.',
    },
    {
      id: 'customer',
      group: 'train',
      name: 'Pubfan Customer',
      role: 'Guest',
      mbti: 'ESFP',
      cluster: 'customer',
      description: `You are Lea, a regular customer using the Pubfan app to browse menus and place orders.`,
      concerns: [
        'Menu and product availability',
        'Order status',
        'Events and reservations',
        'Voucher balance',
      ],
      questionStyle: 'Casual and consumer-focused.',
    },
  ],
};
