'use strict';

// Reads from the GitHub API what the notification needs to know about the
// running deploy. Needs contents: read and actions: read.

const MAX_COMPARE_PAGES = 40; // 100 commits each
const MAX_EARLIER_RUNS = 15;

function createGitHub({ apiUrl, token, repo }) {
  async function get(path) {
    const response = await fetch(`${apiUrl}/repos/${repo}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'deploy-notify',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`GitHub ${path} answered ${response.status}`);
    return response.json();
  }

  return {
    async commitMessage(sha) {
      return (await get(`/commits/${sha}`)).commit.message;
    },

    async pullRequestBody(number) {
      return (await get(`/pulls/${number}`)).body;
    },

    // The commit of the last earlier run in which the job this step runs in
    // succeeded on this branch. Matching the job, not the run, keeps other
    // targets of a shared workflow (a demo deploy from main) out of the answer.
    // `run` describes the running workflow run, see main.js.
    async previousDeploySha(run, sha) {
      const current = await get(`/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100`);
      const job = current.jobs.find((candidate) => candidate.status === 'in_progress' && candidate.runner_name === run.runnerName);
      if (!job) throw new Error(`no running job on runner "${run.runnerName}"`);

      const { workflow_runs: earlier } = await get(
        `/actions/workflows/${encodeURIComponent(run.workflowFile)}/runs?branch=${encodeURIComponent(run.branch)}&status=completed&per_page=${MAX_EARLIER_RUNS}`,
      );
      // A deploy queued behind this one may already be listed; a rerun of the
      // same commit would make the notes empty.
      for (const candidate of earlier.filter(({ run_number: number, head_sha: head }) => number < run.number && head !== sha)) {
        const { jobs } = await get(`/actions/runs/${candidate.id}/jobs?per_page=100`);
        if (jobs.some(({ name, conclusion }) => name === job.name && conclusion === 'success')) return candidate.head_sha;
      }
      throw new Error(`job "${job.name}" did not succeed in the last ${MAX_EARLIER_RUNS} runs`);
    },

    async commitsBetween(baseSha, headSha) {
      const commits = [];
      for (let page = 1; page <= MAX_COMPARE_PAGES; page += 1) {
        const data = await get(`/compare/${baseSha}...${headSha}?per_page=100&page=${page}`);
        commits.push(...data.commits);
        if (commits.length >= data.total_commits) return commits;
      }
      throw new Error(`more than ${MAX_COMPARE_PAGES * 100} commits between ${baseSha} and ${headSha}`);
    },
  };
}

module.exports = { createGitHub };
