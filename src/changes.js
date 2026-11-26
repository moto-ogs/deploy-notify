'use strict';

// Turns the commits between two deploys into the list of changes a reader
// cares about: merged pull requests and direct commits.

const INTEGRATION_BRANCHES = new Set(['development', 'develop', 'staging', 'main', 'master']);

function subject(message) {
  return String(message).split('\n', 1)[0].trim();
}

// The pull request a commit stands for: a GitHub merge commit ("Merge pull
// request #12 from owner/branch", title in the body) or a squash commit
// ("Title (#12)").
function parsePullRequest(message) {
  const merge = /^Merge pull request #(\d+) from [^\s/]+\/(\S+)/.exec(message);
  if (merge) {
    const title = message.split('\n').slice(1).find((line) => line.trim() !== '');
    return { number: Number(merge[1]), title: (title || merge[2]).trim(), branch: merge[2] };
  }
  const squash = /^(.*\S)\s+\(#(\d+)\)$/.exec(subject(message));
  return squash ? { number: Number(squash[2]), title: squash[1] } : null;
}

// The branch a merge commit brought in, when the message names it.
function mergedBranch(message) {
  const pullRequest = parsePullRequest(message);
  if (pullRequest && pullRequest.branch) return pullRequest.branch;
  const local = /^Merge (?:remote-tracking )?branch '(?:origin\/)?([^']+)'/.exec(message);
  return local ? local[1] : null;
}

// Walks the first-parent line from the deployed commit down to the previous
// deploy. Each step is one change: a merged pull request or a direct commit.
// A merge of an integration branch (development into main) is not a change of
// its own, so the walk descends into the line it brought in.
// `commits` are the items of GitHub's compare response.
function collectChanges(commits, headSha) {
  const inRange = new Map(commits.map((commit) => [commit.sha, commit]));
  const visited = new Set();
  const changes = [];

  const walk = (startSha) => {
    for (let sha = startSha; inRange.has(sha) && !visited.has(sha); ) {
      visited.add(sha);
      const { commit, parents } = inRange.get(sha);
      const pullRequest = parsePullRequest(commit.message);
      const isMerge = parents.length > 1;

      if (isMerge && INTEGRATION_BRANCHES.has(mergedBranch(commit.message))) {
        walk(parents[1].sha);
      } else if (pullRequest) {
        changes.push({ number: pullRequest.number, title: pullRequest.title });
      } else if (!isMerge) {
        changes.push({ sha, title: subject(commit.message) });
      }
      sha = parents.length > 0 ? parents[0].sha : undefined;
    }
  };

  walk(headSha);
  return changes;
}

module.exports = { parsePullRequest, collectChanges };
