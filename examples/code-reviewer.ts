/**
 * Example agent: AI Code Reviewer
 *
 * A multi-turn agent that:
 * 1. Takes a code snippet
 * 2. Asks the LLM to find bugs
 * 3. Asks for a fix
 * 4. Asks for a summary
 *
 * Usage:
 *   # Normal (direct to Ollama):
 *   npx tsx examples/code-reviewer.ts
 *
 *   # Through replay proxy (capture mode):
 *   npx tsx examples/code-reviewer.ts --proxy
 *
 * To test the full capture → replay cycle:
 *   1. Start capture:    node dist/cli.js capture --session code-review-1
 *   2. Run this script:  npx tsx examples/code-reviewer.ts --proxy
 *   3. Stop capture:     Ctrl+C the proxy
 *   4. Start replay:     node dist/cli.js replay --session code-review-1
 *   5. Run again:        npx tsx examples/code-reviewer.ts --proxy
 *   → You'll get the EXACT same responses, instantly, no LLM call.
 */

const OLLAMA_DIRECT = 'http://localhost:11434';
const OLLAMA_PROXY = 'http://localhost:11435';
const MODEL = process.env.OLLAMA_MODEL ?? 'qwen3.6:latest';

const useProxy = process.argv.includes('--proxy');
const BASE_URL = useProxy ? OLLAMA_PROXY : OLLAMA_DIRECT;

// A buggy code snippet for the agent to review
const BUGGY_CODE = `
function fetchUsers(ids) {
  const users = [];
  for (let i = 0; i <= ids.length; i++) {
    const res = await fetch('/api/users/' + ids[i]);
    const data = res.json();
    users.push(data);
  }
  return users;
}
`;

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function chat(messages: Message[]): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, stream: true }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM call failed (${res.status}): ${text}`);
  }

  // Parse NDJSON streaming response
  const text = await res.text();
  const lines = text.split('\n').filter((l) => l.trim());
  let content = '';

  for (const line of lines) {
    try {
      const chunk = JSON.parse(line);
      if (chunk.message?.content) content += chunk.message.content;
    } catch { /* skip unparseable */ }
  }

  return content;
}

async function main() {
  console.log(`\n🔍 AI Code Reviewer`);
  console.log(`   Model: ${MODEL}`);
  console.log(`   Target: ${BASE_URL} ${useProxy ? '(via proxy)' : '(direct)'}\n`);
  console.log('─'.repeat(60));

  const conversation: Message[] = [
    { role: 'system', content: 'You are a senior code reviewer. Be concise and specific.' },
  ];

  // Turn 1: Find bugs
  console.log('\n📝 Step 1: Finding bugs...\n');
  conversation.push({
    role: 'user',
    content: `Review this JavaScript function and list all bugs:\n\`\`\`js\n${BUGGY_CODE}\n\`\`\``,
  });

  const bugs = await chat(conversation);
  conversation.push({ role: 'assistant', content: bugs });
  console.log(bugs);
  console.log('\n' + '─'.repeat(60));

  // Turn 2: Fix the code
  console.log('\n🔧 Step 2: Fixing the code...\n');
  conversation.push({
    role: 'user',
    content: 'Now write the corrected version of this function.',
  });

  const fix = await chat(conversation);
  conversation.push({ role: 'assistant', content: fix });
  console.log(fix);
  console.log('\n' + '─'.repeat(60));

  // Turn 3: Summary
  console.log('\n📋 Step 3: Summary...\n');
  conversation.push({
    role: 'user',
    content: 'Give a one-line summary of what was wrong and what you fixed.',
  });

  const summary = await chat(conversation);
  console.log(summary);
  console.log('\n' + '─'.repeat(60));
  console.log('\n✅ Done. 3 LLM turns completed.\n');
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
