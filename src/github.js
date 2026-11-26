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

    // The job this step runs in, found by its runner: its display name
    // identifies the same job in earlier runs, its steps show what failed.
    async currentJob({ runId, runAttempt, runnerName }) {
      const { jobs } = await get(`/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`);
      const job = jobs.find((candidate) => candidate.status === 'in_progress' && candidate.runner_name === runnerName);
      if (!job) throw new Error(`no running job on runner "${runnerName}"`);
      const failedStep = job.steps.find((step) => step.conclusion === 'failure');
      return { name: job.name, failedStep: failedStep ? failedStep.name : null };
    },

    // The commit of the last earlier run in which the same job succeeded on
    // this branch. Matching the job, not the run, keeps other targets of a
    // shared workflow (a demo deploy from main) out of the answer.
    async previousDeploySha({ workflowFile, branch, runNumber, sha, jobName }) {
      const { workflow_runs: runs } = await get(
        `/actions/workflows/${encodeURIComponent(workflowFile)}/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=${MAX_EARLIER_RUNS}`,
      );
      // A deploy queued behind this one may already be listed; a rerun of the
      // same commit would make the notes empty.
      for (const run of runs.filter((candidate) => candidate.run_number < runNumber && candidate.head_sha !== sha)) {
        const { jobs } = await get(`/actions/runs/${run.id}/jobs?per_page=100`);
        if (jobs.some((job) => job.name === jobName && job.conclusion === 'success')) return run.head_sha;
      }
      throw new Error(`job "${jobName}" did not succeed in the last ${MAX_EARLIER_RUNS} runs`);
    },

    async commitsBetween(baseSha, headSha) {
      const commits = [];
      for (let page = 1; page <= MAX_COMPARE_PAGES; page += 1) {
        const data = await get(`/compare/${baseSha}...${headSha}?per_page=100&page=${page}`);
        commits.push(...data.commits);
        if (commits.length >= data.total_commits || data.commits.length === 0) break;
      }
      return commits;
    },
  };
}

module.exports = { createGitHub };
