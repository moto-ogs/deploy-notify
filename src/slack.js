'use strict';

// Returns post(message, threadTs) → the timestamp of the posted message,
// which is the thread id for replies. Dry run prints the payload instead.
function createSlack({ token, channel, dryRun }) {
  return async function post(message, threadTs) {
    const payload = { channel, ...message, thread_ts: threadTs, unfurl_links: false, unfurl_media: false };
    if (dryRun) {
      console.log(JSON.stringify(payload, null, 2));
      return 'dry-run';
    }
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.json();
    if (!body.ok) throw new Error(`Slack chat.postMessage failed: ${body.error}`);
    return body.ts;
  };
}

module.exports = { createSlack };
