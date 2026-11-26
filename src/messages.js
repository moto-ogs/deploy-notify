'use strict';

// Slack payloads (text and Block Kit) for the two messages of a deploy:
// the line in the channel and the release notes in its thread.

const GROUPS = [
  { title: 'Neu', types: ['feat'] },
  { title: 'Behoben', types: ['fix', 'perf', 'revert'] },
  { title: 'Änderungen', types: null }, // titles without a known type
];
const INTERNAL_TYPES = ['chore', 'refactor', 'test', 'tests', 'docs', 'style', 'ci', 'build'];
const MAX_PER_GROUP = 30;
const MAX_TITLE_LENGTH = 200;
// Slack caps a section at 3000 characters.
const SECTION_LIMIT = 2900;

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

function deployMessage({ outcome, app, environment, version, repoUrl, sha, pullRequest, actor, runUrl, failedStep, exitCode }) {
  const target = `${app} ${environment.charAt(0).toUpperCase()}${environment.slice(1)}`.trim();
  const title = `${target}${outcome.phrase}${version ? ` · ${version}` : ''}`;
  const details = [
    pullRequest && `${link(`${repoUrl}/pull/${pullRequest.number}`, `#${pullRequest.number}`)} ${escape(pullRequest.title)}`,
    link(`${repoUrl}/commit/${sha}`, sha.slice(0, 7)),
    actor && escape(actor),
    outcome.failed && failedStep && `Schritt „${escape(failedStep)}“`,
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
  if (INTERNAL_TYPES.includes(type)) return { internal: true };
  const group = GROUPS.find(({ types }) => types && types.includes(type));
  // An unknown word before a colon ("Blog: …") is part of the title.
  return group ? { group, text: match[2] } : { group: GROUPS[GROUPS.length - 1], text: title };
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
  let internal = 0;
  for (const change of changes) {
    const { group, text, internal: isInternal } = classify(change.title);
    if (isInternal) internal += 1;
    else listed.get(group).push(changeLine(change, text, repoUrl));
  }

  const lines = [];
  for (const [{ title }, items] of listed) {
    if (items.length === 0) continue;
    lines.push('', `*${title}*`, ...items.slice(0, MAX_PER_GROUP));
    if (items.length > MAX_PER_GROUP) lines.push(`_… und ${items.length - MAX_PER_GROUP} weitere_`);
  }
  if (internal > 0) {
    lines.push('', `_Dazu ${plural(internal, 'interne Änderung', 'interne Änderungen')} (Wartung, Tests, Doku)._`);
  }
  return lines;
}

// Packs lines into as few sections as Slack's size limit allows.
function toSections(lines) {
  const chunks = [];
  for (const line of lines) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.length + 1 + line.length <= SECTION_LIMIT) chunks[chunks.length - 1] = `${last}\n${line}`;
    else if (line !== '') chunks.push(line);
  }
  return chunks.map(section);
}

function releaseNotesMessage({ changes, repoUrl, baseSha, headSha }) {
  const summary =
    changes.length === 0 ? 'keine Änderungen seit dem letzten Deploy' : plural(changes.length, 'Änderung', 'Änderungen');
  const heading = `*Release Notes* · ${summary} · ${link(`${repoUrl}/compare/${baseSha}...${headSha}`, 'Diff')}`;
  return {
    text: `Release Notes · ${summary}`,
    blocks: toSections([heading, ...releaseNotesLines({ changes, repoUrl })]),
  };
}

module.exports = { deployMessage, releaseNotesMessage };
