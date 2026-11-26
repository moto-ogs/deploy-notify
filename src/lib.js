'use strict';

// Pure logic: which outcomes reach Slack, what the messages say, and how
// release notes are derived from a commit range. No I/O in this file.

const INTEGRATION_BRANCHES = new Set(['development', 'develop', 'staging', 'main', 'master']);
const LISTED_GROUPS = [
  { key: 'feat', title: 'Neu' },
  { key: 'fix', title: 'Behoben' },
  { key: 'other', title: 'Änderungen' },
];
const TYPE_GROUP = { feat: 'feat', fix: 'fix', perf: 'fix', revert: 'fix' };
const INTERNAL_TYPES = new Set(['chore', 'refactor', 'test', 'tests', 'docs', 'style', 'ci', 'build']);
const MAX_PER_GROUP = 30;
const SECTION_LIMIT = 2900;

// Exit codes of moto's deploy-remote.sh. Only read when the caller opts in
// with exit_codes=deploy-remote; other tools use these numbers differently.
const DEPLOY_REMOTE_OUTCOMES = { 1: 'aborted', 10: 'rolled_back', 11: 'rollback_failed' };

function resolveOutcome({ status, exitCode, exitCodes }) {
  if (status === 'success') return 'success';
  if (status === 'cancelled') return 'cancelled';
  if (exitCodes === 'deploy-remote' && DEPLOY_REMOTE_OUTCOMES[exitCode]) {
    return DEPLOY_REMOTE_OUTCOMES[exitCode];
  }
  return 'failure';
}

// The one rule the channel agreed on: production deploys, and failures
// everywhere. A cancelled run is noise unless it was production.
function shouldNotify({ outcome, environment }) {
  if (outcome === 'success' || outcome === 'cancelled') return environment === 'production';
  return true;
}

function displayEnvironment(environment) {
  return environment ? environment[0].toUpperCase() + environment.slice(1) : '';
}

function headline({ outcome, app, environment }) {
  const target = `${app} ${displayEnvironment(environment)}`.trim();
  switch (outcome) {
    case 'success':
      return { emoji: '🚀', text: `${target} deployed` };
    case 'cancelled':
      return { emoji: '🚫', text: `${target}: Deploy abgebrochen` };
    case 'aborted':
      return { emoji: '⚠️', text: `${target}: Deploy vor dem Start abgebrochen` };
    case 'rolled_back':
      return { emoji: '⚠️', text: `${target}: Deploy fehlgeschlagen, zurückgerollt` };
    case 'rollback_failed':
      return { emoji: '🚨', text: `${target}: Deploy und Rollback fehlgeschlagen` };
    default:
      return { emoji: '❌', text: `${target}: Deploy fehlgeschlagen` };
  }
}

function escapeMrkdwn(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function link(url, label) {
  return `<${url}|${escapeMrkdwn(label)}>`;
}

function firstLine(text) {
  return String(text || '').split('\n', 1)[0].trim();
}

// Reads the pull request a commit stands for: a GitHub merge commit
// ("Merge pull request #12 from owner/branch", title in the body) or a squash
// commit ("Title (#12)").
function parsePullRequest(message) {
  const text = String(message || '');
  const merge = /^Merge pull request #(\d+) from [^\s/]+\/(\S+)/.exec(text);
  if (merge) {
    const body = text.split('\n').slice(1).find((line) => line.trim() !== '');
    return { number: Number(merge[1]), branch: merge[2], title: (body || merge[2]).trim(), merge: true };
  }
  const squash = /^(.*\S)\s+\(#(\d+)\)$/.exec(firstLine(text));
  if (squash) return { number: Number(squash[2]), title: squash[1], merge: false };
  return null;
}

function mergedIntegrationBranch(message) {
  const match = /^Merge (?:remote-tracking )?branch '(?:origin\/)?([^']+)'/.exec(String(message || ''));
  return match && INTEGRATION_BRANCHES.has(match[1]) ? match[1] : null;
}

// Walks the first-parent line from the deployed commit down to the previous
// deploy. Each step is one unit of change: a merged pull request or a direct
// commit. A merge of an integration branch (development into main) is not a
// change of its own, so the walk descends into the branch it brought in.
// `commits` are the items of GitHub's compare response.
function collectChanges(commits, headSha) {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const seen = new Set();
  const changes = [];

  const walk = (startSha) => {
    let sha = startSha;
    while (sha && bySha.has(sha) && !seen.has(sha)) {
      seen.add(sha);
      const commit = bySha.get(sha);
      const message = commit.commit.message;
      const parents = commit.parents.map((parent) => parent.sha);
      const pr = parsePullRequest(message);

      if (parents.length >= 2) {
        if (pr && pr.merge) {
          if (INTEGRATION_BRANCHES.has(pr.branch)) walk(parents[1]);
          else if (!pr.branch.startsWith('release-please--')) {
            changes.push({ number: pr.number, title: pr.title });
          }
        } else if (mergedIntegrationBranch(message)) {
          walk(parents[1]);
        }
      } else if (pr) {
        changes.push({ number: pr.number, title: pr.title });
      } else {
        changes.push({ sha, title: firstLine(message) });
      }
      sha = parents[0];
    }
  };

  walk(headSha);
  return changes;
}

function classify(title) {
  const match = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(title);
  if (!match) return { group: 'other', text: title };
  const type = match[1].toLowerCase();
  if (INTERNAL_TYPES.has(type)) return { group: 'internal', text: match[2] };
  if (TYPE_GROUP[type]) return { group: TYPE_GROUP[type], text: match[2] };
  // An unknown word before a colon ("Blog: ...") is part of the title.
  return { group: 'other', text: title };
}

function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function releaseNotesText({ changes, repoUrl, baseSha, headSha }) {
  const diff = link(`${repoUrl}/compare/${baseSha}...${headSha}`, 'Diff');
  if (changes.length === 0) {
    return `*Release Notes* · keine Änderungen seit dem letzten Deploy · ${diff}`;
  }

  const groups = { feat: [], fix: [], other: [], internal: [] };
  for (const change of changes) {
    const { group, text } = classify(change.title);
    const ref = change.number
      ? link(`${repoUrl}/pull/${change.number}`, `#${change.number}`)
      : link(`${repoUrl}/commit/${change.sha}`, change.sha.slice(0, 7));
    groups[group].push(`• ${escapeMrkdwn(capitalize(text))} ${ref}`);
  }

  const count = changes.length === 1 ? '1 Änderung' : `${changes.length} Änderungen`;
  const lines = [`*Release Notes* · ${count} · ${diff}`];
  for (const { key, title } of LISTED_GROUPS) {
    const items = groups[key];
    if (items.length === 0) continue;
    lines.push('', `*${title}*`, ...items.slice(0, MAX_PER_GROUP));
    if (items.length > MAX_PER_GROUP) lines.push(`_… und ${items.length - MAX_PER_GROUP} weitere_`);
  }
  if (groups.internal.length > 0) {
    const internal = groups.internal.length === 1 ? '1 interne Änderung' : `${groups.internal.length} interne Änderungen`;
    lines.push('', `_Dazu ${internal} (Wartung, Tests, Doku)._`);
  }
  return lines.join('\n');
}

// Slack caps a section at 3000 characters; split at line breaks.
function toSections(text) {
  const blocks = [];
  let current = '';
  for (const line of text.split('\n')) {
    const next = current === '' ? line : `${current}\n${line}`;
    if (next.length > SECTION_LIMIT && current !== '') {
      blocks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current.trim() !== '') blocks.push(current);
  return blocks.map((chunk) => ({ type: 'section', text: { type: 'mrkdwn', text: chunk.slice(0, 3000) } }));
}

function contextBlock(parts) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: parts.filter(Boolean).join('  ·  ') }] };
}

function deployMessage({ outcome, app, environment, version, repoUrl, sha, pullRequest, actor, runUrl, failedStep, exitCode }) {
  const { emoji, text } = headline({ outcome, app, environment });
  const title = version ? `${text} · ${version}` : text;
  const failed = outcome !== 'success' && outcome !== 'cancelled';
  const parts = [
    pullRequest
      ? `${link(`${repoUrl}/pull/${pullRequest.number}`, `#${pullRequest.number}`)} ${escapeMrkdwn(pullRequest.title)}`
      : null,
    link(`${repoUrl}/commit/${sha}`, sha.slice(0, 7)),
    actor ? escapeMrkdwn(actor) : null,
    failed && failedStep ? `Schritt „${escapeMrkdwn(failedStep)}“` : null,
    failed && exitCode ? `Exit ${escapeMrkdwn(exitCode)}` : null,
    link(runUrl, failed ? 'Log ansehen' : 'Run'),
  ];
  return {
    text: `${emoji} ${title}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${emoji} *${escapeMrkdwn(title)}*` } },
      contextBlock(parts),
    ],
  };
}

function releaseNotesMessage(notes) {
  const text = releaseNotesText(notes);
  return { text: firstLine(text).replace(/[*_]/g, ''), blocks: toSections(text).slice(0, 50) };
}

module.exports = {
  resolveOutcome,
  shouldNotify,
  headline,
  parsePullRequest,
  collectChanges,
  classify,
  releaseNotesText,
  releaseNotesMessage,
  deployMessage,
  toSections,
};
