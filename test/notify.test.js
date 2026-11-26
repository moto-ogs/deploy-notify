'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveOutcome, reachesChannel } = require('../src/outcomes.js');
const { parsePullRequest, collectChanges } = require('../src/changes.js');
const { deployMessage, releaseNotesMessage } = require('../src/messages.js');

const REPO = 'https://github.com/moto-ogs/demo';

function commit(sha, message, ...parents) {
  return { sha, commit: { message }, parents: parents.map((parent) => ({ sha: parent })) };
}

function notesText(changes) {
  return releaseNotesMessage({ changes, repoUrl: REPO, baseSha: 'aaaaaaa1', headSha: 'bbbbbbb2' })
    .blocks.map((block) => block.text.text)
    .join('\n');
}

test('only production deploys and failures reach the channel', () => {
  const cases = [
    ['success', '', 'production', true],
    ['success', '', 'staging', false],
    ['success', '', 'demo', false],
    ['failure', '', 'production', true],
    ['failure', '', 'staging', true],
    ['failure', '', 'demo', true],
    ['failure', '10', 'staging', true],
    ['cancelled', '', 'production', true],
    ['cancelled', '', 'staging', false],
  ];
  for (const [status, exitCode, environment, expected] of cases) {
    const outcome = resolveOutcome({ status, exitCode, exitCodes: 'deploy-remote' });
    assert.equal(reachesChannel(outcome, environment), expected, `${outcome.name} on ${environment}`);
  }
});

test('deploy-remote exit codes are read only on request', () => {
  const name = (status, exitCode, exitCodes) => resolveOutcome({ status, exitCode, exitCodes }).name;
  assert.equal(name('failure', '10', 'deploy-remote'), 'rolled_back');
  assert.equal(name('failure', '11', 'deploy-remote'), 'rollback_failed');
  assert.equal(name('failure', '1', 'deploy-remote'), 'aborted');
  // rsync also exits with 10 and 11; without the opt-in that is a plain failure.
  assert.equal(name('failure', '10', ''), 'failure');
  assert.equal(name('success', '0', 'deploy-remote'), 'success');
  assert.equal(name('cancelled', '10', 'deploy-remote'), 'cancelled');
});

test('reads the pull request from merge and squash commits', () => {
  assert.deepEqual(parsePullRequest('Merge pull request #12 from moto-ogs/fix/thing\n\nfix: Ding repariert'), {
    number: 12,
    title: 'fix: Ding repariert',
    branch: 'fix/thing',
  });
  assert.deepEqual(parsePullRequest('feat: Neues Ding (#7)\n\nBody'), { number: 7, title: 'feat: Neues Ding' });
  assert.equal(parsePullRequest('Direct commit'), null);
});

test('a release merge lists the pull requests it brought in, not itself', () => {
  // main: m0 <- M (merge of development). development: d1 <- P1 <- P2,
  // where P1/P2 merge feature branches f1/f2 and d1 is a direct commit.
  const commits = [
    commit('f1', 'fix: wip', 'm0'),
    commit('d1', 'chore: direkt auf development', 'm0'),
    commit('P1', 'Merge pull request #1 from moto-ogs/fix/a\n\nfix: A behoben', 'd1', 'f1'),
    commit('f2', 'feat: wip', 'P1'),
    commit('f2b', "Merge branch 'development' into feat/b", 'f2', 'P1'),
    commit('P2', 'Merge pull request #2 from moto-ogs/feat/b\n\nfeat(frontend): B gebaut', 'P1', 'f2b'),
    commit('M', 'Merge pull request #4 from moto-ogs/development\n\nRelease development nach main', 'm0', 'P2'),
  ];
  assert.deepEqual(collectChanges(commits, 'M'), [
    { number: 2, title: 'feat(frontend): B gebaut' },
    { number: 1, title: 'fix: A behoben' },
    { sha: 'd1', title: 'chore: direkt auf development' },
  ]);
});

test('direct pushes, squash merges and locally merged integration branches are listed', () => {
  const commits = [
    commit('a', 'Fix typo on slide 4', 'base'),
    commit('b', 'feat: Export als PDF (#9)', 'a'),
    commit('x', 'Kam über einen Pull von main', 'base'),
    commit('c', "Merge branch 'main' of https://github.com/moto-ogs/demo into topic", 'b', 'x'),
    commit('y', 'wip auf einem Feature-Branch', 'base'),
    commit('d', "Merge branch 'feature/y'", 'c', 'y'),
    commit('x2', 'fix: kam über development', 'base'),
    commit('e', "Merge branch 'development'", 'd', 'x2'),
  ];
  assert.deepEqual(collectChanges(commits, 'e'), [
    { sha: 'x2', title: 'fix: kam über development' },
    { sha: 'x', title: 'Kam über einen Pull von main' },
    { number: 9, title: 'feat: Export als PDF' },
    { sha: 'a', title: 'Fix typo on slide 4' },
  ]);
});

test('release notes group by kind and count internal work', () => {
  const text = notesText([
    { number: 2, title: 'feat(frontend): b <gebaut> & fertig' },
    { number: 1, title: 'fix: A behoben' },
    { number: 5, title: 'Blog: Gründungsgeschichte' },
    { number: 6, title: 'chore(deps): bump' },
    { sha: 'abcdef1234', title: 'docs: Readme' },
  ]);
  assert.equal(
    text,
    [
      `*Release Notes* · 5 Änderungen · <${REPO}/compare/aaaaaaa1...bbbbbbb2|Diff>`,
      '',
      '*Neu*',
      `• B &lt;gebaut&gt; &amp; fertig <${REPO}/pull/2|#2>`,
      '',
      '*Behoben*',
      `• A behoben <${REPO}/pull/1|#1>`,
      '',
      '*Änderungen*',
      `• Blog: Gründungsgeschichte <${REPO}/pull/5|#5>`,
      '',
      '_Dazu 2 interne Änderungen (Wartung, Tests, Doku)._',
    ].join('\n'),
  );
});

test('long groups are capped and long notes split into sections', () => {
  const changes = Array.from({ length: 80 }, (_, index) => ({
    number: index + 1,
    title: `fix: ${'Sehr langer Titel '.repeat(30)}${index}`,
  }));
  const message = releaseNotesMessage({ changes, repoUrl: REPO, baseSha: 'a', headSha: 'b' });
  const all = message.blocks.map((block) => block.text.text).join('\n');
  assert.equal((all.match(/^• /gm) || []).length, 30);
  assert.match(all, /… und 50 weitere/);
  assert.ok(message.blocks.length > 1);
  for (const block of message.blocks) assert.ok(block.text.text.length <= 3000);
  assert.equal(message.text, 'Release Notes · 80 Änderungen');
});

test('an empty range says so', () => {
  assert.equal(
    notesText([]),
    `*Release Notes* · keine Änderungen seit dem letzten Deploy · <${REPO}/compare/aaaaaaa1...bbbbbbb2|Diff>`,
  );
});

test('deploy message: success line and failure details', () => {
  const base = {
    app: 'Phoenix',
    repoUrl: REPO,
    sha: '1234567890abcdef',
    actor: 'yonnock',
    runUrl: `${REPO}/actions/runs/1`,
    version: '',
    pullRequest: { number: 4, title: 'Release <dev> nach main' },
  };
  const ok = deployMessage({
    ...base,
    outcome: resolveOutcome({ status: 'success' }),
    environment: 'production',
    version: 'v1.2.3',
    failedStep: null,
    exitCode: '0',
  });
  assert.equal(ok.text, '🚀 Phoenix Production deployed · v1.2.3');
  assert.equal(ok.blocks[0].text.text, '🚀 *Phoenix Production deployed · v1.2.3*');
  assert.equal(
    ok.blocks[1].elements[0].text,
    `<${REPO}/pull/4|#4> Release &lt;dev&gt; nach main  ·  <${REPO}/commit/1234567890abcdef|1234567>  ·  yonnock  ·  <${REPO}/actions/runs/1|Run>`,
  );

  const failed = deployMessage({
    ...base,
    outcome: resolveOutcome({ status: 'failure', exitCode: '10', exitCodes: 'deploy-remote' }),
    environment: 'staging',
    pullRequest: null,
    failedStep: 'Deploy to staging',
    exitCode: '10',
  });
  assert.equal(failed.text, '⚠️ Phoenix Staging: Deploy fehlgeschlagen, zurückgerollt');
  assert.equal(
    failed.blocks[1].elements[0].text,
    `<${REPO}/commit/1234567890abcdef|1234567>  ·  yonnock  ·  Schritt „Deploy to staging“  ·  Exit 10  ·  <${REPO}/actions/runs/1|Log ansehen>`,
  );
});
