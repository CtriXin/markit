# Acceptance Plan

hard gates:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm probe:pixels
pnpm e2e:tongzhang-er
python3 /Users/xin/auto-skills/shared-skills/frontend-baseline/scripts/check_baseline.py --root . --shape static-spa --profile internal-tool
python3 /Users/xin/auto-skills/CtriXin-repo/creator-gate/scripts/validate_packet.py .ai/creator-gate/2026-06-15-markit-v1-bootstrap
```

rendered dom / rendered Playwright acceptance:

- Start fixture `http://127.0.0.1:4888/inflation-2.html` and Markit app.
- Create `Mobile 390x844` Markit session.
- Verify first screenshot, domain URL chip, viewport metadata, and DOM targets.
- Simulate all 5 “通胀二” bug records:
  - `TZ2-001` mobile menu: element pick.
  - `TZ2-002` hero CTA: pin.
  - `TZ2-003` CPI chart label: freehand draw.
  - `TZ2-004` Germany card title: rect two-click.
  - `TZ2-005` country dropdown: browse click + element pick.
- Verify browse actions: click, scroll, type.
- Verify full-page capture.
- Verify AI normalizer applies draft fields.
- Verify bug list/detail has 5 bugs and no `0 annotations` card.
- Export every bug and verify Markdown, JSON, annotated screenshot, and crop files.

review-hub acceptance:

```bash
PATH="/Users/xin/auto-skills/CtriXin-repo/markit/.agent.local/bin:$PATH" python3 /Users/xin/auto-skills/CtriXin-repo/review-hub/.agent.local/overlays/mmf-review-dispatch/scripts/mmf_review_dispatch_execute.py \
  --root /Users/xin/auto-skills/CtriXin-repo/markit \
  --model qwen3.7 \
  --model mimo2.5 \
  --model minimaxm3 \
  --title "Markit full function delivery review" \
  --summary "Review Markit implementation for URL capture, annotation tools, bug workflow, export evidence, AI normalizer, visual quality, and Playwright E2E evidence." \
  --allow-incomplete
```

Result: request root `.mission/review-dispatch/opencode/20260615T120124Z-markit-full-function-delivery-review/`, aggregate complete `3/3`, incomplete `0`.


ai:doctor: not installed for this local tool bootstrap; creator-gate validation and frontend-baseline check are used instead.
