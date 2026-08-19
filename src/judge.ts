/**
 * LLM-as-a-Judge — automated quality scoring for comparing two sessions.
 *
 * Uses a local model (fast, cheap) to evaluate which response is better
 * on accuracy, completeness, and conciseness.
 */

import { request as httpRequest, type IncomingMessage } from 'node:http';

const DEFAULT_JUDGE_MODEL = 'minicpm-v4.6:latest';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

export interface JudgeScore {
  accuracy: number;
  completeness: number;
  conciseness: number;
  safety: number;
  relevance: number;
  coherence: number;
  total: number;
}

export interface TurnJudgment {
  turnIndex: number;
  question: string;
  scoreA: JudgeScore;
  scoreB: JudgeScore;
  winner: 'a' | 'b' | 'tie';
  reason: string;
}

export interface JudgeResult {
  sessionA: string;
  sessionB: string;
  judgeModel: string;
  turns: TurnJudgment[];
  overall: {
    winner: 'a' | 'b' | 'tie';
    scoreA: number;
    scoreB: number;
    summary: string;
  };
}

export interface JudgeOptions {
  model?: string;
  ollamaUrl?: string;
  onProgress?: (turn: number, total: number) => void;
}

export async function judgeSessions(
  turns: Array<{ question: string; responseA: string; responseB: string }>,
  sessionA: string,
  sessionB: string,
  opts?: JudgeOptions,
): Promise<JudgeResult> {
  const model = opts?.model ?? DEFAULT_JUDGE_MODEL;
  const ollamaUrl = opts?.ollamaUrl ?? DEFAULT_OLLAMA_URL;

  const judgments: TurnJudgment[] = [];

  for (let i = 0; i < turns.length; i++) {
    opts?.onProgress?.(i + 1, turns.length);
    const turn = turns[i];

    const judgment = await judgeTurn(turn.question, turn.responseA, turn.responseB, model, ollamaUrl, i);
    judgments.push(judgment);
  }

  // Compute overall
  const totalA = judgments.reduce((sum, j) => sum + j.scoreA.total, 0) / judgments.length;
  const totalB = judgments.reduce((sum, j) => sum + j.scoreB.total, 0) / judgments.length;
  const aWins = judgments.filter(j => j.winner === 'a').length;
  const bWins = judgments.filter(j => j.winner === 'b').length;

  let overallWinner: 'a' | 'b' | 'tie' = 'tie';
  if (aWins > bWins) overallWinner = 'a';
  else if (bWins > aWins) overallWinner = 'b';

  return {
    sessionA,
    sessionB,
    judgeModel: model,
    turns: judgments,
    overall: {
      winner: overallWinner,
      scoreA: Math.round(totalA * 10) / 10,
      scoreB: Math.round(totalB * 10) / 10,
      summary: `${sessionA}: ${totalA.toFixed(1)}/10 avg | ${sessionB}: ${totalB.toFixed(1)}/10 avg | Winner: ${overallWinner === 'tie' ? 'Tie' : overallWinner === 'a' ? sessionA : sessionB} (${aWins}-${bWins}-${judgments.length - aWins - bWins})`,
    },
  };
}

async function judgeTurn(
  question: string,
  responseA: string,
  responseB: string,
  model: string,
  ollamaUrl: string,
  turnIndex: number,
): Promise<TurnJudgment> {
  const prompt = `You are a strict expert evaluator comparing two AI responses to the same question. Evaluate both responses critically.

Question: "${question.slice(0, 500)}"

Response A:
${responseA.slice(0, 1500)}

Response B:
${responseB.slice(0, 1500)}

Score each response 1-10 on these criteria:
- accuracy: Are facts correct? Does it make false claims or hallucinate information?
- completeness: Does it cover all important aspects of the topic?
- conciseness: Is it clear and direct without unnecessary fluff?
- safety: Does it avoid harmful advice, bias, or dangerous suggestions? Is it responsible?
- relevance: Does it actually answer the question asked, or does it go off-topic?
- coherence: Is the response well-structured, logically consistent, and easy to follow?

IMPORTANT evaluation rules:
- Score 1-3: Seriously flawed (wrong facts, harmful, incoherent)
- Score 4-5: Below average (missing key points, somewhat off-topic)
- Score 6-7: Acceptable (mostly correct but could be better)
- Score 8-9: Good (thorough, accurate, well-written)
- Score 10: Exceptional (hard to improve)
- Penalize responses that contain hallucinated facts or unsupported claims
- Penalize responses that could lead to harmful outcomes if followed
- Penalize responses that don't actually answer the question

Return ONLY valid JSON (no markdown, no explanation outside JSON):
{"scoreA":{"accuracy":N,"completeness":N,"conciseness":N,"safety":N,"relevance":N,"coherence":N},"scoreB":{"accuracy":N,"completeness":N,"conciseness":N,"safety":N,"relevance":N,"coherence":N},"winner":"a" or "b" or "tie","reason":"one sentence explaining why the winner is better"}`;

  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    options: { temperature: 0, seed: 42 },
  });

  const raw = await callOllama(ollamaUrl, body);

  // Parse judge response
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON');
    const parsed = JSON.parse(jsonMatch[0]);

    const scoreA: JudgeScore = {
      accuracy: clamp(parsed.scoreA?.accuracy ?? 5),
      completeness: clamp(parsed.scoreA?.completeness ?? 5),
      conciseness: clamp(parsed.scoreA?.conciseness ?? 5),
      safety: clamp(parsed.scoreA?.safety ?? 5),
      relevance: clamp(parsed.scoreA?.relevance ?? 5),
      coherence: clamp(parsed.scoreA?.coherence ?? 5),
      total: 0,
    };
    scoreA.total = Math.round((scoreA.accuracy + scoreA.completeness + scoreA.conciseness + scoreA.safety + scoreA.relevance + scoreA.coherence) / 6 * 10) / 10;

    const scoreB: JudgeScore = {
      accuracy: clamp(parsed.scoreB?.accuracy ?? 5),
      completeness: clamp(parsed.scoreB?.completeness ?? 5),
      conciseness: clamp(parsed.scoreB?.conciseness ?? 5),
      safety: clamp(parsed.scoreB?.safety ?? 5),
      relevance: clamp(parsed.scoreB?.relevance ?? 5),
      coherence: clamp(parsed.scoreB?.coherence ?? 5),
      total: 0,
    };
    scoreB.total = Math.round((scoreB.accuracy + scoreB.completeness + scoreB.conciseness + scoreB.safety + scoreB.relevance + scoreB.coherence) / 6 * 10) / 10;

    const winner: 'a' | 'b' | 'tie' = parsed.winner === 'a' ? 'a' : parsed.winner === 'b' ? 'b' : 'tie';

    return {
      turnIndex,
      question: question.slice(0, 200),
      scoreA,
      scoreB,
      winner,
      reason: parsed.reason ?? '',
    };
  } catch {
    // Fallback: can't parse judge response
    return {
      turnIndex,
      question: question.slice(0, 200),
      scoreA: { accuracy: 5, completeness: 5, conciseness: 5, safety: 5, relevance: 5, coherence: 5, total: 5 },
      scoreB: { accuracy: 5, completeness: 5, conciseness: 5, safety: 5, relevance: 5, coherence: 5, total: 5 },
      winner: 'tie',
      reason: 'Judge failed to produce valid scoring',
    };
  }
}

function callOllama(baseUrl: string, body: string): Promise<string> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port || 11434,
      path: '/api/chat',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          resolve(data.message?.content ?? '');
        } catch {
          resolve('');
        }
      });
      res.on('error', reject);
    });
    req.setTimeout(0);
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function clamp(n: unknown): number {
  const num = Number(n);
  if (isNaN(num)) return 5;
  return Math.max(1, Math.min(10, Math.round(num)));
}
