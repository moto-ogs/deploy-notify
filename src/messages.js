'use strict';

// Slack payloads (text and Block Kit) for the messages of a deploy: the line
// in the channel and, in its thread, the release notes and the description of
// the deployed pull request.

const UNTYPED = { title: 'Änderungen' }; // titles without a known type
const GROUPS = [
  { title: 'Neu', types: ['feat'] },
  { title: 'Behoben', types: ['fix', 'perf', 'revert'] },
  UNTYPED,
  { title: 'Sonstiges', types: ['chore', 'refactor', 'test', 'tests', 'docs', 'style', 'ci', 'build'] },
];
const MAX_PER_GROUP = 30;
const MAX_TITLE_LENGTH = 200;
// Slack caps a section at 3000 characters.
const SECTION_LIMIT = 2900;
// Slack caps the markdown blocks of one message at 12000 characters.
const MARKDOWN_LIMIT = 11000;

function escape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function link(url, label) {
  return `<${url}|${escape(label)}>`;
}

function section(text) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function plural(count, one, many) {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

function deployMessage({ outcome, app, environment, version, repoUrl, sha, pullRequest, actor, runUrl, exitCode }) {
  const target = `${app} ${environment.charAt(0).toUpperCase()}${environment.slice(1)}`.trim();
  const title = `${target}${outcome.phrase}${version ? ` · ${version}` : ''}`;
  const details = [
    pullRequest && `${link(`${repoUrl}/pull/${pullRequest.number}`, `#${pullRequest.number}`)} ${escape(pullRequest.title)}`,
    link(`${repoUrl}/commit/${sha}`, sha.slice(0, 7)),
    actor && escape(actor),
    outcome.failed && exitCode && exitCode !== '0' && `Exit ${escape(exitCode)}`,
    link(runUrl, outcome.failed ? 'Log ansehen' : 'Run'),
  ];
  return {
    text: `${outcome.emoji} ${title}`,
    blocks: [
      section(`${outcome.emoji} *${escape(title)}*`),
      { type: 'context', elements: [{ type: 'mrkdwn', text: details.filter(Boolean).join('  ·  ') }] },
    ],
  };
}

// Splits a conventional-commit title into its type and the rest.
function classify(title) {
  const match = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(title);
  const type = match ? match[1].toLowerCase() : null;
  const group = GROUPS.find(({ types }) => types && types.includes(type));
  // An unknown word before a colon ("Blog: …") is part of the title.
  return group ? { group, text: match[2] } : { group: UNTYPED, text: title };
}

function changeLine(change, text, repoUrl) {
  const shown = text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH)}…` : text;
  const reference = change.number
    ? link(`${repoUrl}/pull/${change.number}`, `#${change.number}`)
    : link(`${repoUrl}/commit/${change.sha}`, change.sha.slice(0, 7));
  return `• ${escape(shown.charAt(0).toUpperCase() + shown.slice(1))} ${reference}`;
}

function releaseNotesLines({ changes, repoUrl }) {
  const listed = new Map(GROUPS.map((group) => [group, []]));
  for (const change of changes) {
    const { group, text } = classify(change.title);
    listed.get(group).push(changeLine(change, text, repoUrl));
  }

  const lines = [];
  for (const [{ title }, items] of listed) {
    if (items.length === 0) continue;
    lines.push('', `*${title}*`, ...items.slice(0, MAX_PER_GROUP));
    if (items.length > MAX_PER_GROUP) lines.push(`_… und ${items.length - MAX_PER_GROUP} weitere_`);
  }
  return lines;
}

// Packs lines into as few chunks of at most `limit` characters as possible.
function pack(lines, limit) {
  const chunks = [];
  for (const line of lines) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.length + 1 + line.length <= limit) chunks[chunks.length - 1] = `${last}\n${line}`;
    else if (line.trim() !== '') chunks.push(line.slice(0, limit));
  }
  return chunks;
}

function releaseNotesMessage({ changes, repoUrl, baseSha, headSha }) {
  const summary =
    changes.length === 0 ? 'keine Änderungen seit dem letzten Deploy' : plural(changes.length, 'Änderung', 'Änderungen');
  const heading = `*Release Notes* · ${summary} · ${link(`${repoUrl}/compare/${baseSha}...${headSha}`, 'Diff')}`;
  return {
    text: `Release Notes · ${summary}`,
    blocks: pack([heading, ...releaseNotesLines({ changes, repoUrl })], SECTION_LIMIT).map(section),
  };
}

// The description of the deployed pull request as its author wrote it, one
// message per MARKDOWN_LIMIT characters. Slack renders the Markdown itself.
function descriptionMessages({ pullRequest, body, repoUrl }) {
  const visible = String(body || '').replace(/<!--[\s\S]*?-->/g, '');
  const heading = `*Beschreibung* · ${link(`${repoUrl}/pull/${pullRequest.number}`, `#${pullRequest.number}`)}`;
  return pack(visible.split(/\r?\n/), MARKDOWN_LIMIT).map((text, index) => ({
    text: `Beschreibung von #${pullRequest.number}`,
    blocks: [...(index === 0 ? [section(heading)] : []), { type: 'markdown', text }],
  }));
}

module.exports = { deployMessage, releaseNotesMessage, descriptionMessages };
