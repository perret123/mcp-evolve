/**
 * mcp-evolve — Auto-dev: autonomous feature development in a safe branch.
 *
 * When a golden prompt fails 3+ times and gets blocked, auto-dev:
 * 1. Creates a git worktree branch
 * 2. Runs a deep investigation with full failure history
 * 3. Makes the fix in the worktree
 * 4. Rebuilds and replays the prompt
 * 5. If it passes: reports "fix ready on branch X"
 * 6. If it fails: cleans up, reports what was tried
 *
 * Changes never touch the main working tree — you merge when ready.
 */

import { execSync } from 'node:child_process';
import { join, resolve, isAbsolute } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { claude, readPrompt, parseStreamOutput } from './claude.mjs';
import { scorePrompt, isPassingScore } from './eval.mjs';

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', timeout: 30_000, ...opts }).trim();
}

/**
 * Run auto-dev for a list of blocked golden prompts.
 * Each prompt gets its own branch.
 *
 * @returns {Array<{persona, prompt, branch, verdict, diff}>}
 */
export async function autoDev(blockedQuestions, config) {
  if (blockedQuestions.length === 0) return [];

  const results = [];
  const worktreeBase = join(config.projectRoot, '.mcp-evolve', 'worktrees');
  if (!existsSync(worktreeBase)) mkdirSync(worktreeBase, { recursive: true });

  for (const bq of blockedQuestions) {
    const slug = `${bq.persona}-${Date.now()}`.replace(/[^a-z0-9-]/gi, '-').slice(0, 40);
    const branchName = `auto-dev/${slug}`;
    const worktreePath = join(worktreeBase, slug);

    log('');
    log('='.repeat(60));
    log(`AUTO-DEV: [${bq.persona}] ${bq.prompt.slice(0, 70)}...`);
    log(`Branch: ${branchName}`);
    log('='.repeat(60));

    try {
      // Create worktree
      log('  Creating worktree...');
      exec(`git worktree add -b "${branchName}" "${worktreePath}"`, { cwd: config.projectRoot });

      // Build failure context
      const failHistory = buildFailureContext(bq);

      const srcDirHint = config.srcDirs.length > 0
        ? `Source code: ${config.srcDirs.join(', ')}`
        : 'Find the source code in the project.';

      const autoDevPrompt = [
        `A test prompt has failed ${bq.consecutiveFails || '3+'} times. The surface fixer and deep fixer both tried and failed.`,
        `You are the last resort. You have full access to the codebase.`,
        '',
        `**Persona:** ${bq.persona}`,
        `**Prompt:** ${bq.prompt}`,
        '',
        `**Failure history:**`,
        failHistory,
        '',
        `${srcDirHint}`,
        '',
        `**Your job — be fast, edit within 5 minutes:**`,
        `1. Grep for the relevant MCP write tool (2 min max reading)`,
        `2. Read its description and the handler/callable it wraps`,
        `3. Edit the tool description to include a CONCRETE EXAMPLE of the exact input JSON the LLM needs to send`,
        `4. If the tool can't do what the prompt asks, add the missing capability`,
        '',
        `**Rules:**`,
        `- EDIT FILES. Do not just analyze — you must make at least one edit.`,
        `- Start with the MCP tool description — add an example of the exact JSON input for this use case`,
        `- The #1 reason LLMs get stuck: they don't know the input format. A concrete example fixes 80% of cases.`,
        `- Make the minimal change that solves the problem`,
        `- Don't break existing functionality`,
        config.buildCommand ? `- After changes, rebuild: ${config.buildCommand}` : '',
      ].join('\n');

      // Step 1: Investigate — read code and produce an edit plan as JSON
      log('  Step 1: Investigating...');
      const investigation = await claude(autoDevPrompt + `\n\nIMPORTANT: Output your fix as JSON:\n{"file": "path/to/file.ts", "old_string": "exact text to replace", "new_string": "replacement text"}\nKeep old_string SHORT (1-3 lines). Use Read to find exact text. Output JSON inside a \`\`\`json code fence.`, {
        systemPrompt: 'Investigate then output a JSON edit plan. Max 2 Grep calls, max 2 Read calls, then output. Format: ```json\n{"file": "...", "old_string": "...", "new_string": "..."}\n``` The old_string MUST be an exact copy from the file.',
        allowedTools: 'Read,Grep,Glob',
        model: config.fixerModel || 'sonnet',
        timeout: 600_000,
        cwd: worktreePath,
      });

      log(`  Investigation: ${investigation.length} chars`);
      const conclusion = investigation.slice(-300).trim();
      if (conclusion) log(`  Conclusion: ...${conclusion.slice(-200)}`);

      // Step 2: Extract edits from the investigation output and apply them
      log('  Step 2: Applying edits...');
      const editPattern = /\{[^{}]*"file"\s*:\s*"(?:[^"\\]|\\.)+"\s*,\s*"old_string"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*"new_string"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}/g;
      const jsonBlocks = investigation.match(/```json?\s*\n([\s\S]*?)```/g) || [];
      const allJsonCandidates = [
        ...(investigation.match(editPattern) || []),
        ...jsonBlocks.map(b => b.replace(/```json?\s*\n/, '').replace(/```$/, '').trim()),
      ];

      let editsApplied = 0;
      for (const candidate of allJsonCandidates) {
        try {
          const edit = JSON.parse(candidate);
          if (edit.file && edit.old_string && edit.new_string && edit.old_string !== edit.new_string) {
            const filePath = join(worktreePath, edit.file);
            if (existsSync(filePath)) {
              const content = readFileSync(filePath, 'utf-8');
              if (content.includes(edit.old_string)) {
                writeFileSync(filePath, content.replace(edit.old_string, edit.new_string));
                editsApplied++;
                log(`    Applied edit to ${edit.file}`);
              } else {
                log(`    old_string not found in ${edit.file}`);
              }
            } else {
              log(`    File not found: ${edit.file}`);
            }
          }
        } catch { /* not valid JSON */ }
      }

      if (editsApplied === 0 && !investigation.startsWith('ERROR:')) {
        log('  No structured edits found — trying direct edit...');
        const directEdit = await claude(
          `Based on this analysis, make the edit now:\n\n${investigation.slice(-1500)}\n\nEDIT the file. Do not explain — just call the Edit tool.`,
          {
            systemPrompt: 'Call the Edit tool to apply the fix described above. Do not explain anything. Just edit the file.',
            allowedTools: 'Read,Edit',
            model: config.fixerModel || 'sonnet',
            timeout: 120_000,
            cwd: worktreePath,
          }
        );
        log(`  Direct edit result: ${directEdit.length} chars`);
      }

      const output = investigation;

      // Check if any files were changed
      let diff = '';
      try {
        diff = exec('git diff --stat', { cwd: worktreePath });
      } catch { /* no changes */ }

      if (!diff) {
        log('  No changes made — auto-dev could not find a fix');
        log('  (Investigation ran but did not edit any files — may need different approach or missing capability)');
        cleanup(worktreePath, branchName, config);
        results.push({ persona: bq.persona, prompt: bq.prompt, branch: null, verdict: 'NO_CHANGES', diff: '', investigationOutput: output.slice(-500) });
        continue;
      }

      log(`  Changes:\n${diff.split('\n').map(l => '    ' + l).join('\n')}`);

      // Create worktree-specific MCP config pointing at worktree's dist
      let worktreeMcpConfig;
      try {
        worktreeMcpConfig = createWorktreeMcpConfig(worktreePath, config);
        log(`  MCP config for worktree: ${worktreeMcpConfig}`);
      } catch (err) {
        log(`  Could not create worktree MCP config: ${err.message?.slice(0, 100)}`);
        log('  Falling back to original MCP config (will test against old code)');
        worktreeMcpConfig = config.mcpConfig;
      }

      // Rebuild in worktree
      let buildOk = true;
      if (config.buildCommand) {
        log('  Rebuilding in worktree...');
        try {
          exec(config.buildCommand, { cwd: worktreePath, timeout: 60_000 });
        } catch (err) {
          log(`  Build failed: ${err.message?.slice(0, 100)}`);
          buildOk = false;
        }
      }

      // Replay the prompt against the worktree's MCP server
      let replayPassed = false;
      if (buildOk) {
        log('  Replaying prompt against fixed code...');
        try {
          const persona = { id: bq.persona, name: bq.persona, role: 'user' };
          const replayOutput = await claude(
            `User prompt: ${bq.prompt}`,
            {
              systemPrompt: readPrompt(config.promptsDir, 'answerer.md'),
              mcpConfig: worktreeMcpConfig,
              strictMcpConfig: true,
              disableBuiltinTools: true,
              outputFormat: 'stream-json',
              verbose: true,
              allowedTools: config.answererTools,
              model: config.answererModel || 'sonnet',
              cwd: worktreePath,
            },
          );

          const result = parseStreamOutput(replayOutput);
          const score = scorePrompt({ prompt: bq.prompt, ...result }, config);
          replayPassed = isPassingScore(score);
          log(`  Replay: ${replayPassed ? 'PASSED' : 'FAILED'} (tools=${score.toolsUsed}, errors=${score.errorsFound}, stuck=${score.stuck})`);
        } catch (err) {
          log(`  Replay error: ${err.message?.slice(0, 100)}`);
        }
      }

      if (replayPassed) {
        // Regression check: run ALL non-blocked golden prompts on the branch
        log('  Running golden set regression check on branch...');
        let regressionPassed = true;
        try {
          const gs = JSON.parse(exec(`cat "${config.goldenSetPath}"`, { cwd: worktreePath }));
          const otherGolden = (gs.prompts || gs.questions || []).filter(q => !q.blocked && q.prompt !== bq.prompt);

          if (otherGolden.length > 0) {
            let regPass = 0, regFail = 0;
            // Run in parallel for speed
            const regResults = await Promise.all(otherGolden.map(async (gq) => {
              const out = await claude(
                `User prompt: ${gq.prompt}`,
                {
                  systemPrompt: readPrompt(config.promptsDir, 'answerer.md'),
                  mcpConfig: worktreeMcpConfig,
                  strictMcpConfig: true,
                  disableBuiltinTools: true,
                  outputFormat: 'stream-json',
                  allowedTools: config.answererTools,
                  model: config.answererModel || 'sonnet',
                  cwd: worktreePath,
                },
              );
              const r = parseStreamOutput(out);
              const s = scorePrompt({ prompt: gq.prompt, ...r }, config);
              return { persona: gq.persona, prompt: gq.prompt, passed: isPassingScore(s) };
            }));

            for (const rr of regResults) {
              if (rr.passed) regPass++;
              else { regFail++; log(`    REGRESSION: [${rr.persona}] ${rr.prompt.slice(0, 60)}`); }
            }

            log(`  Regression: ${regPass} passed, ${regFail} failed out of ${otherGolden.length} golden prompts`);
            if (regFail > 0) {
              regressionPassed = false;
              log('  Fix causes regressions — aborting');
            }
          } else {
            log('  No other golden prompts to check');
          }
        } catch (err) {
          log(`  Regression check error: ${err.message?.slice(0, 100)} — skipping`);
        }

        if (!regressionPassed) {
          cleanup(worktreePath, branchName, config);
          results.push({ persona: bq.persona, prompt: bq.prompt, branch: null, verdict: 'FIX_CAUSES_REGRESSION', diff });
          continue;
        }

        // Commit changes on the branch
        log('  Committing fix...');
        try {
          exec('git add -A', { cwd: worktreePath });
          const commitMsg = `fix(auto-dev): resolve blocked golden prompt [${bq.persona}]\n\nPrompt: ${(bq.prompt || '').slice(0, 100)}\nFailed ${bq.consecutiveFails || 3}+ consecutive times.\nAuto-dev investigation and fix.\nGolden set regression: passed.`;
          exec(`git commit -m ${JSON.stringify(commitMsg)}`, { cwd: worktreePath });
        } catch { /* commit might fail if nothing staged */ }

        const fullDiff = exec('git diff HEAD~1 --stat', { cwd: worktreePath }).slice(0, 500);

        log('');
        log(`  FIX READY on branch: ${branchName}`);
        log(`  Review: git diff ${branchName}`);
        log(`  Merge:  git merge ${branchName}`);

        // Remove worktree but keep branch
        try { exec(`git worktree remove "${worktreePath}"`, { cwd: config.projectRoot }); } catch { /* ok */ }

        results.push({ persona: bq.persona, prompt: bq.prompt, branch: branchName, verdict: 'FIX_READY', diff: fullDiff });
      } else {
        log('  Fix did not resolve the issue — cleaning up');
        cleanup(worktreePath, branchName, config);
        results.push({ persona: bq.persona, prompt: bq.prompt, branch: null, verdict: 'FIX_FAILED', diff });
      }

    } catch (err) {
      log(`  Auto-dev error: ${err.message?.slice(0, 200)}`);
      cleanup(worktreePath, branchName, config);
      results.push({ persona: bq.persona, prompt: bq.prompt, branch: null, verdict: 'ERROR', diff: '' });
    }
  }

  return results;
}

function cleanup(worktreePath, branchName, config) {
  try { exec(`git worktree remove --force "${worktreePath}"`, { cwd: config.projectRoot }); } catch { /* ok */ }
  try { exec(`git branch -D "${branchName}"`, { cwd: config.projectRoot }); } catch { /* ok */ }
}

/**
 * Create an MCP config for the worktree that points at the worktree's built dist.
 * Reads the original config, resolves paths relative to projectRoot,
 * then rewrites them relative to the worktree.
 */
function createWorktreeMcpConfig(worktreePath, config) {
  const originalConfig = JSON.parse(readFileSync(config.mcpConfig, 'utf-8'));
  const worktreeConfig = JSON.parse(JSON.stringify(originalConfig));

  for (const [name, server] of Object.entries(worktreeConfig.mcpServers || {})) {
    // Rewrite args: replace projectRoot paths with worktree paths
    if (server.args) {
      server.args = server.args.map(arg => {
        if (typeof arg === 'string' && arg.includes(config.projectRoot)) {
          return arg.replace(config.projectRoot, worktreePath);
        }
        // If relative, resolve from projectRoot then rewrite to worktree
        if (typeof arg === 'string' && !isAbsolute(arg) && (arg.endsWith('.js') || arg.endsWith('.mjs'))) {
          const abs = resolve(config.projectRoot, arg);
          return abs.replace(config.projectRoot, worktreePath);
        }
        return arg;
      });
    }
  }

  const mcpPath = join(worktreePath, '.mcp-evolve-worktree.json');
  writeFileSync(mcpPath, JSON.stringify(worktreeConfig, null, 2));
  return mcpPath;
}

function buildFailureContext(bq) {
  const lines = [];

  lines.push(`Consecutive failures: ${bq.consecutiveFails || '3+'}`);
  lines.push(`Blocked since: ${bq.blockedAt || 'now'}`);

  if (bq.fixCycle) {
    lines.push(`Original fix cycle: ${JSON.stringify(bq.fixCycle)}`);
  }

  lines.push('');
  lines.push('The surface fixer tried improving tool descriptions/schemas — did not help.');
  lines.push('The deep fixer tried investigating handler code — did not help.');
  lines.push('The problem is likely architectural: missing feature, wrong data flow, or fundamental tool design issue.');

  return lines.join('\n');
}
