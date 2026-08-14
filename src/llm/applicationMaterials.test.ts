import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { generateCompactApplicationMaterials } from './applicationMaterials';

const messagesPrototype = Object.getPrototypeOf(new Anthropic({ apiKey: 'test-key' }).messages) as {
  create: (...args: unknown[]) => unknown;
};

test('one Sonnet call returns a cover letter and every requested answer', async (t) => {
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
    inputTokens: 2400,
    outputTokens: 720,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });
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
