import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { generateCompactApplicationMaterials } from './applicationMaterials';

const messagesPrototype = Object.getPrototypeOf(new Anthropic({ apiKey: 'test-key' }).messages) as {
  create: (...args: unknown[]) => unknown;
};
const responsesPrototype = Object.getPrototypeOf(new OpenAI({ apiKey: 'test-key' }).responses) as {
  create: (...args: unknown[]) => unknown;
};

test('the Anthropic fallback returns a cover letter and every requested answer', async (t) => {
  t.after(() => mock.restoreAll());
  const calls: Record<string, unknown>[] = [];
  mock.method(messagesPrototype, 'create', async (body: Record<string, unknown>) => {
    calls.push(body);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          cover_letter: 'A tailored cover letter for Acme.',
          answers: [
            { id: 'why', answer: 'I built the same kind of system at Acme Labs.' },
            { id: 'project', answer: 'The project I would point to is my Python pipeline.' },
          ],
        }),
      }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2400, output_tokens: 720 },
    };
  });

  const result = await generateCompactApplicationMaterials({
    company: 'Acme',
    role: 'Software Engineer',
    jdText: 'Build Python services.',
    candidateSource: 'Acme Labs, Python pipeline.',
    includeCoverLetter: true,
    questions: [
      { id: 'why', question: 'Why this role?' },
      { id: 'project', question: 'Tell us about a project.' },
    ],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'claude-sonnet-5');
  assert.equal(calls[0].max_tokens, 16384);
  assert.equal(result.coverLetter, 'A tailored cover letter for Acme.');
  assert.equal(result.answers.get('why'), 'I built the same kind of system at Acme Labs.');
  assert.equal(result.answers.get('project'), 'The project I would point to is my Python pipeline.');
  assert.deepEqual(result.usage, {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    inputTokens: 2400,
    outputTokens: 720,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });
});

test('OpenAI is primary and uses structured output for the compact packet', async (t) => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  t.after(() => {
    mock.restoreAll();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  const calls: Record<string, unknown>[] = [];
  mock.method(responsesPrototype, 'create', async (body: Record<string, unknown>) => {
    calls.push(body);
    return {
      status: 'completed',
      output_text: JSON.stringify({
        cover_letter: 'A grounded letter for Acme.',
        answers: [{ id: 'why', answer: 'I built the same kind of service at Acme Labs.' }],
      }),
      incomplete_details: null,
      usage: {
        input_tokens: 800,
        output_tokens: 220,
        input_tokens_details: { cache_write_tokens: 0, cached_tokens: 100 },
      },
    };
  });
  mock.method(messagesPrototype, 'create', async () => {
    throw new Error('Anthropic should not run when OpenAI succeeds');
  });

  const result = await generateCompactApplicationMaterials({
    company: 'Acme',
    role: 'Software Engineer',
    jdText: 'Build Python services.',
    candidateSource: 'Acme Labs, Python service.',
    includeCoverLetter: true,
    questions: [{ id: 'why', question: 'Why this role?' }],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'gpt-5.6-terra');
  assert.deepEqual((calls[0].reasoning as { effort?: string }).effort, 'medium');
  assert.equal(
    ((calls[0].text as { format?: { type?: string } }).format?.type),
    'json_schema',
  );
  assert.equal(result.coverLetter, 'A grounded letter for Acme.');
  assert.equal(result.answers.get('why'), 'I built the same kind of service at Acme Labs.');
  assert.equal(result.usage?.provider, 'openai');
  assert.equal(result.usage?.cacheReadInputTokens, 100);
});

test('a packet missing a requested answer fails instead of silently dropping the field', async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(messagesPrototype, 'create', async () => ({
    content: [{ type: 'text', text: '{"cover_letter":null,"answers":[]}' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 20 },
  }));

  await assert.rejects(
    () => generateCompactApplicationMaterials({
      company: 'Acme',
      role: 'Software Engineer',
      jdText: 'Build Python services.',
      candidateSource: 'Acme Labs, Python pipeline.',
      includeCoverLetter: false,
      questions: [{ id: 'why', question: 'Why this role?' }],
    }),
    /omitted compact application answer why/,
  );
});

test('an OpenAI provider error immediately falls back to Anthropic', async (t) => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  t.after(() => {
    mock.restoreAll();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });
  mock.method(responsesPrototype, 'create', async () => {
    throw new Error('simulated OpenAI outage');
  });
  mock.method(messagesPrototype, 'create', async () => ({
    content: [{ type: 'text', text: '{"cover_letter":null,"answers":[{"id":"why","answer":"Grounded fallback answer."}]}' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 200, output_tokens: 40 },
  }));

  const result = await generateCompactApplicationMaterials({
    company: 'Acme',
    role: 'Engineer',
    jdText: 'Build services.',
    candidateSource: 'Built services.',
    includeCoverLetter: false,
    questions: [{ id: 'why', question: 'Why this role?' }],
  });

  assert.equal(result.answers.get('why'), 'Grounded fallback answer.');
  assert.equal(result.usage?.provider, 'anthropic');
});
