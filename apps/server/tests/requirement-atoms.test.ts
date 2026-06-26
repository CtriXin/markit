import { describe, expect, it } from 'vitest';
import { requirementAtomLedgerFromDetail } from '../src/routes/bugs.js';

// S3 provenance contract (docs/atom-output-contract.md): once a bug is submitted,
// the atom ledger must carry gl:<iid> / feishu:<token> provenance. The submit flow
// re-exports the bug so this projection runs with issueSubmission populated.
function detailWith(issueSubmission?: { iid?: number; feishuSync?: { attachmentFileTokens?: string[] } }) {
  return {
    bug: {
      id: 'bug_9bb5de9aXXXX',
      title: '价格字重应为 500/600',
      actual: '',
      expected: '',
      severity: 'P1',
      finalUrl: 'https://example.com/catalog',
      issueSubmission
    },
    captures: [
      { id: 'cap1', finalUrl: 'https://example.com/catalog', viewport: { isMobile: false } }
    ],
    annotations: [
      {
        id: 'anno1',
        captureId: 'cap1',
        kind: 'element',
        note: '价格字重应为 500/600，当前 400 偏细',
        geometry: { captureRect: { x: 0, y: 0, width: 10, height: 10 } },
        target: { selector: "[data-testid='price-tag']" }
      }
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('requirement_atom.v1 provenance writeback', () => {
  it('stamps gl:<iid> + feishu:<token> when the bug is submitted', () => {
    const ledger = requirementAtomLedgerFromDetail(
      detailWith({ iid: 42, feishuSync: { attachmentFileTokens: ['img_v3_abc'] } }),
      new Map()
    );
    expect(ledger.schema).toBe('requirement_atom.v1');
    expect(ledger.source_ref).toBe('gl:42'); // top-level provenance written back
    expect(ledger.atoms).toHaveLength(1);
    const atom = ledger.atoms[0];
    expect(atom.source.ref).toBe('gl:42'); // per-atom provenance written back
    expect(atom.evidence_refs).toEqual(['feishu:img_v3_abc']);
    // minimal-core invariants preserved
    expect(atom.source.anchor.type).toBe('element');
    expect(atom.source.anchor.value).toBe("[data-testid='price-tag']");
    expect(atom.source.anchor.value).not.toBe('page'); // never whole-page
    expect(atom.assertion).toBeNull();
    expect(atom.status).toBe('pending');
  });

  it('leaves provenance null/empty before submit (ref captured at submit, not invented)', () => {
    const ledger = requirementAtomLedgerFromDetail(detailWith(undefined), new Map());
    expect(ledger.source_ref).toBeNull();
    expect(ledger.atoms[0].source.ref).toBeNull();
    expect(ledger.atoms[0].evidence_refs).toEqual([]);
  });
});
