import { describe, expect, it } from 'vitest';
import { classifyCandidate } from '@/detection/engine';
import { decide } from '@/policy/decide';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import type { Classification } from '@/domain/classification';
import type { NormalizedVideoCandidate } from '@/domain/video';

/**
 * V4-04 — live miss sample (fixture-independent evidence).
 *
 * Provenance: titles + video IDs captured from signed-out YouTube
 * search results on 2026-09-25 (surface=search, four queries, recorded
 * verbatim below; no fixture, no hand-tuning). The capture method was:
 * a Chromium instance visiting https://www.youtube.com/results?... and
 * reading rendered card titles — the same DOM surfaces the extension reads.
 *
 * Labels are developer judgments from titles, not verified video-content
 * ground truth. Rules were added after inspecting these misses, so this is
 * development/regression data, not an untouched evaluation sample. It tests
 * title-signal coverage and protects discussion/human control cases.
 */

interface LiveCase {
  readonly videoId: string;
  readonly title: string;
  /** Query the case was captured from (provenance). */
  readonly query: string;
  /** Label: materially AI-generated/synthetic content. */
  readonly ai: boolean;
  /** Label: AI-discussion (about AI, not made of AI) — must stay visible. */
  readonly discussion?: boolean | undefined;
}

const Q1 = 'ai+generated+baby+fresh+2026';
const Q2 = 'oddly+satisfying+ai+video';
const Q3 = 'veo+3+ai+video';
const Q4 = 'woodworking+handmade+furniture';

const LIVE_SAMPLE: readonly LiveCase[] = [
  // ── Q1: ai generated baby fresh 2026 (5 captured) ──
  {
    videoId: 'Ux5bcqh-NQs',
    title: 'DUTY & CROWN | Full Movie | 4K (AI Film)',
    query: Q1,
    ai: true,
  },
  {
    videoId: 'rWpYqKGfFm8',
    title:
      'Oddly satisfying AI food Slide | Baby laughing & Eating | Baby laughing sound | Baby Giggles sound',
    query: Q1,
    ai: true,
  },
  {
    videoId: 'oEmksBhyUmI',
    title: 'The Cutest Fruit Babies Ever! 😍🍎🍓🍇 | Cute AI Animation',
    query: Q1,
    ai: true,
  },

  // ── Q2: oddly satisfying ai video (17 captured) ──
  {
    videoId: 'isAd9gPWxLI',
    title: 'The Cutest AI Fruit Babies Ever 🍓🍉 | Oddly Satisfying Eating Animation',
    query: Q2,
    ai: true,
  },
  {
    videoId: 'A8qxHaDxmBI',
    title:
      'Nice or Cute? AI fruit Babies & Big Fruit 👶🍊🍓🥑 | The Ultimate Oddly Satisfying AI ASMR #viralvideo',
    query: Q2,
    ai: true,
  },
  {
    videoId: 'Q35xh5TWnjQ',
    title: 'Which Crazy Bedroom Would You Choose? 🌙 😴| Oddly Satisfying ASMR AI Animation',
    query: Q2,
    ai: true,
  },
  {
    videoId: 'qLtncWOCLek',
    title: '30 Minutes The Most Satisfying AI ASMR Top of the best compilations Most Viral',
    query: Q2,
    ai: true,
  },
  {
    videoId: '3ll5jzjNIcs',
    title: '【4K】Satisfying 3D Simulations Showcase 【60fps】',
    query: Q2,
    ai: true,
  },
  {
    videoId: 'WY8WJYKFHO4',
    title: 'Ultimate Crazy Staircase Compilation – Most Satisfying AI Video Ever ASMR',
    query: Q2,
    ai: true,
  },
  {
    videoId: 'B-naHns76Ug',
    title: 'Which Unreal Beds Would You Choose Tonight?🌙 | Oddly Satisfying AI ASMR #6',
    query: Q2,
    ai: true,
  },
  {
    videoId: 'uKaedgieSW4',
    title: 'Fall Asleep With 1 Hour of The Best AI ASMR!',
    query: Q2,
    ai: true,
  },
  {
    videoId: '2W4njedYWxc',
    title: 'Which Choose? Insane AI Beds | Ultimate Oddly Satisfying Compilation ASMR',
    query: Q2,
    ai: true,
  },
  {
    videoId: 'LC1GN5JEBIs',
    title:
      'Oddly satisfying AI food Slide | Baby laughing & Eating | Baby laughing sound | Baby Giggles',
    query: Q2,
    ai: true,
  },
  {
    videoId: '-g3-7UVbVt0',
    title: 'ULTIMATE Oddly Satisfying AI ASMR | Cute AI Fruit Babies Eating Compilation (55 Mins)',
    query: Q2,
    ai: true,
  },
  {
    videoId: 'uOg7iGecnao',
    title: '💡How to Make AI ASMR Videos and Monetize $7500/Month without Ads',
    query: Q2,
    ai: false,
    discussion: true,
  },
  {
    videoId: 'sKWd0c1Bwcs',
    title: 'Satisfying AI ASMR Magical Waterslide – Surreal Slides of Many Materials',
    query: Q2,
    ai: true,
  },
  {
    videoId: 'hWJOejrMFLk',
    title: 'Ocean Would You Swim In? | AI ASMR Relaxing',
    query: Q2,
    ai: true,
  },
  {
    videoId: 'rmVsCUBc8Rc',
    title: 'Satisfying AI ASMR Planet Spread | Oddly Satisfying Toast',
    query: Q2,
    ai: true,
  },
  {
    videoId: '3kIcwmhgGLk',
    title:
      'Oddly satisfying AI food Slide | Baby laughing sound | Baby laughing & Eating | Baby Giggle',
    query: Q2,
    ai: true,
  },

  // ── Q3: veo 3 ai video (16 captured) — the AI-discussion minefield ──
  {
    videoId: 'IjF5Uun2jrM',
    title: 'Google Veo 3 Tutorial: Make Cinematic AI Videos with Just a Prompt',
    query: Q3,
    ai: false,
    discussion: true,
  },
  {
    videoId: 'UC_Cw9xqIuE',
    title: 'FREE Veo 3 AI Video Generator : How to Use It WORLDWIDE',
    query: Q3,
    ai: false,
    discussion: true,
  },
  {
    videoId: '-MluR9dqt5w',
    title: 'Kling 3.0 vs Seedance 2.0 vs Veo 3.1 vs Sora 2: The Ultimate AI Video Comparison',
    query: Q3,
    ai: false,
    discussion: true,
  },
  {
    videoId: 'aeYgN0kJigY',
    title:
      'Paano Gumawa ng AI Video Gamit ang Cellphone | Step-by-Step AI Video Tutorial Tagalog 2025',
    query: Q3,
    ai: false,
    discussion: true,
  },
  {
    videoId: 'c7R94ykz0po',
    title: 'AI Videos in 2025 Are Getting Crazy! Google Veo 3 TUTORIAL!',
    query: Q3,
    ai: false,
    discussion: true,
  },
  {
    videoId: '3iUfJzFwoG4',
    title: 'How I Use VEO 3 To Create Viral AI Videos In 11 Minutes',
    query: Q3,
    ai: false,
    discussion: true,
  },
  {
    videoId: 'K4OrSx0Vkj0',
    title: 'Veo 3 is now on Artlist',
    query: Q3,
    ai: false,
    discussion: true,
  },
  {
    videoId: 'oodW_W15rLY',
    title: 'GOOGLE VEO 3: THE DEFINITIVE GUIDE FROM SCRATCH TO VIRAL VIDEOS AND PROMPTS',
    query: Q3,
    ai: false,
    discussion: true,
  },
  {
    videoId: 'Cqcf3XEwPeo',
    title: '100+ Veo 3 AI Videos – Indistinguishable from Reality',
    query: Q3,
    ai: false,
    discussion: true,
  },
  {
    videoId: '-8hyuXPaljo',
    title: 'Google Veo 3 AI in Telugu',
    query: Q3,
    ai: false,
    discussion: true,
  },
  {
    videoId: '4yZ25JGh3gs',
    title: 'ABUSING VEO 3 Video AI',
    query: Q3,
    ai: false,
    discussion: true,
  },
  {
    videoId: 'pD4q9zwWvRg',
    title: 'THE CLEANER | Flow By Google | Veo 3 | Gen AI Short Film',
    query: Q3,
    ai: true,
  },
  {
    videoId: 'sUEcEEEinVk',
    title: 'I Tried Google’s FREE AI Video Generators (Only 3 Are Worth Using)',
    query: Q3,
    ai: false,
    discussion: true,
  },
  {
    videoId: 'gcZwE5cM4xs',
    title: 'Google’s new AI video tool Veo 3 is WILD!',
    query: Q3,
    ai: false,
    discussion: true,
  },
  {
    videoId: 'PL_izvWJVLU',
    title: 'STOP Wasting Credits & Become a VEO 3 Master in 8 Minutes',
    query: Q3,
    ai: false,
    discussion: true,
  },
  {
    videoId: '1lktT4dVAT4',
    title: 'Create Cinematic Ai Videos with Google VEO 3 (FULL COURSE)',
    query: Q3,
    ai: false,
    discussion: true,
  },

  // ── Q4: woodworking handmade furniture (19 captured, human controls) ──
  {
    videoId: 'o9O8cthWvB0',
    title: 'I Spent 213 Hours Turning 2200 Yr Old Wood into $12,000 Table',
    query: Q4,
    ai: false,
  },
  {
    videoId: 'xau74kckNMs',
    title:
      'Extremely Ingenious Skills Woodworking Worker || Making Cross Joints Bed Monolithic Wood Projects',
    query: Q4,
    ai: false,
  },
  { videoId: 'IFpeFO_onrI', title: 'Outdoor Wooden Folding Table', query: Q4, ai: false },
  {
    videoId: 'CstPSMJ9l8c',
    title: 'Flint Hill Furniture - Custom Furniture by Louis Lovas',
    query: Q4,
    ai: false,
  },
  {
    videoId: 'lxjJRWYulr8',
    title: '10000$Walnut and epoxy table. WOODWORKING',
    query: Q4,
    ai: false,
  },
  {
    videoId: 't2fSFt0epfc',
    title: 'Wooden Chair Design Without Nails / Woodworking',
    query: Q4,
    ai: false,
  },
  {
    videoId: 'iEVk4Oflho8',
    title: 'From Rusty Boat Wood to Luxury Furniture: An Incredible Transformation!',
    query: Q4,
    ai: false,
  },
  {
    videoId: 'XSuuateHSAA',
    title: 'A Second Life for Pallets: Turning Discarded Wood into a Gorgeous Coffee Table',
    query: Q4,
    ai: false,
  },
  { videoId: '7KkvrgMk8Us', title: 'How to Build Cabinets', query: Q4, ai: false },
  {
    videoId: 'iTR4ikppnwY',
    title:
      'Woodworking: Transforming a Found Roadside Wood Piece into a Beautiful Epoxy Resin Table',
    query: Q4,
    ai: false,
  },
  {
    videoId: 'n7Qvg1-kokg',
    title:
      'Building A Difficult, rustic Table From Rotten Old Wood // Woodworking Restore Old Wood',
    query: Q4,
    ai: false,
  },
  {
    videoId: 'ZfiCP-wZ34g',
    title: 'Solid Walnut Dresser with Hand-Cut Dovetails — The Biloxi Dresser',
    query: Q4,
    ai: false,
  },
  {
    videoId: 'Zoy4hDrQEfk',
    title: 'Organic Wood Furniture Design Ideas to Transform Your Living Spaces',
    query: Q4,
    ai: false,
  },
  { videoId: 'X8Ly-BgyHPs', title: 'I Turned Down $7,000 For This', query: Q4, ai: false },
  {
    videoId: 'QNgJjm0JX7Y',
    title:
      'How a Coffee Table Is Born | The Story of an Artistic Table | Wood Shaping and Craft Art',
    query: Q4,
    ai: false,
  },
  { videoId: 'ql3-2y9Kex0', title: 'Making Ancient Chinese jewelry box', query: Q4, ai: false },
  { videoId: 'LxY-PB4WE10', title: 'Fine Furniture / Woodworking', query: Q4, ai: false },
  {
    videoId: 'wKg0lMrBOiU',
    title: 'No Nails. No Screws. Just Joinery - Watch a Japanese Style Space Come to Life',
    query: Q4,
    ai: false,
  },
  { videoId: 'NeIx8DlxJSM', title: 'Making benches for a Museum', query: Q4, ai: false },
];

function liveCandidate(c: LiveCase): NormalizedVideoCandidate {
  return {
    videoId: c.videoId,
    title: c.title,
    channel: { channelId: 'UCLIVE0000000000000000', displayName: 'Live Sample' },
    surface: 'search',
    cardKind: 'video',
    badges: [],
    ariaLabels: [],
    metadataText: ['45K views', '1 month ago'],
    isShort: false,
    observedAt: 1_700_000_000_000,
  };
}

function liveDecide(
  c: LiveCase,
  cl: Classification,
  mode: UserSettings['mode'],
): 'allow' | 'warn' | 'hide' {
  return decide({
    settings: { ...defaultSettings(), mode },
    rules: defaultRules(),
    candidate: { videoId: c.videoId, channelId: 'UCLIVE0000000000000000', title: c.title },
    classification: cl,
  }).action;
}

describe('V4-04 live-title regression sample (captured 2026-09-25)', () => {
  it('hard gate: AI-discussion content stays visible in every mode', async () => {
    const discussion = LIVE_SAMPLE.filter((c) => c.discussion);
    expect(discussion.length).toBeGreaterThanOrEqual(14);
    const hidden: string[] = [];
    for (const c of discussion) {
      const cl = await classifyCandidate(liveCandidate(c), {});
      for (const mode of ['safe', 'balanced', 'strict', 'aggressive'] as const) {
        if (liveDecide(c, cl, mode) === 'hide') hidden.push(`${mode}:${c.videoId}:${c.title}`);
      }
    }
    expect(hidden).toEqual([]);
  });

  it('hard gate: human-craft controls stay visible in every mode', async () => {
    const controls = LIVE_SAMPLE.filter((c) => !c.ai && !c.discussion && c.query === Q4);
    expect(controls.length).toBe(19);
    const hidden: string[] = [];
    for (const c of controls) {
      const cl = await classifyCandidate(liveCandidate(c), {});
      for (const mode of ['safe', 'balanced', 'strict', 'aggressive'] as const) {
        if (liveDecide(c, cl, mode) === 'hide') hidden.push(`${mode}:${c.videoId}:${c.title}`);
      }
    }
    expect(hidden).toEqual([]);
  });

  it('miss taxonomy: per-mode hides and bucketed reasons for live AI-slop', async () => {
    const slop = LIVE_SAMPLE.filter((c) => c.ai);
    const perMode: Record<UserSettings['mode'], number> = {
      safe: 0,
      balanced: 0,
      strict: 0,
      aggressive: 0,
    };
    const warnPerMode: Record<UserSettings['mode'], number> = {
      safe: 0,
      balanced: 0,
      strict: 0,
      aggressive: 0,
    };
    // Miss buckets (taxonomy): why an AI-labeled case stays visible.
    const buckets: Record<
      'no-signal' | 'below-floor' | 'confidence-gated' | 'capped-or-opposed' | 'warn-not-hide',
      string[]
    > = {
      'no-signal': [], // engine produced no category evidence at all
      'below-floor': [], // has signal but max score < aggressive hideAt
      'confidence-gated': [], // score would hide but confidence class cannot
      'capped-or-opposed': [], // dimension cap or opposing evidence suppressed
      'warn-not-hide': [], // decision lands on warn in aggressive
    };
    for (const c of slop) {
      const cl = await classifyCandidate(liveCandidate(c), {});
      for (const mode of ['safe', 'balanced', 'strict', 'aggressive'] as const) {
        const act = liveDecide(c, cl, mode);
        if (act === 'hide') perMode[mode] += 1;
        if (act === 'warn') warnPerMode[mode] += 1;
      }
      // Bucket on the WEAKEST mode that misses (aggressive): what keeps it
      // visible even there?
      const agg = liveDecide(c, cl, 'aggressive');
      if (agg === 'hide') continue;
      const maxScore = Math.max(cl.aiLikelihood, cl.slopLikelihood);
      const entry = `${c.videoId}:${c.title.slice(0, 70)}`;
      if (Object.keys(cl.categories).length === 0) buckets['no-signal'].push(entry);
      else if (agg === 'warn') buckets['warn-not-hide'].push(entry);
      else if (maxScore < 0.35) buckets['below-floor'].push(entry);
      else if (cl.confidence === 'low') buckets['confidence-gated'].push(entry);
      else buckets['capped-or-opposed'].push(entry);
    }
    console.log(
      `V404 live sample: n=${LIVE_SAMPLE.length} slop-labeled=${slop.length}\n` +
        `AI-slop outcomes per mode (hide/warn/visible of ${slop.length}): ` +
        `safe=${perMode.safe}/${warnPerMode.safe}/${slop.length - perMode.safe - warnPerMode.safe} ` +
        `balanced=${perMode.balanced}/${warnPerMode.balanced}/${slop.length - perMode.balanced - warnPerMode.balanced} ` +
        `strict=${perMode.strict}/${warnPerMode.strict}/${slop.length - perMode.strict - warnPerMode.strict} ` +
        `aggressive=${perMode.aggressive}/${warnPerMode.aggressive}/${slop.length - perMode.aggressive - warnPerMode.aggressive}\n` +
        `miss buckets (aggressive misses): ${Object.entries(buckets)
          .map(([k, v]) => `${k}=${v.length}`)
          .join(' ')}\n` +
        Object.entries(buckets)
          .filter(([, v]) => v.length > 0)
          .map(([k, v]) => `${k}: ${v.join(' | ')}`)
          .join('\n'),
    );
    expect(LIVE_SAMPLE.length).toBe(54);
    // The taxonomy must actually classify every miss into exactly one bucket.
    const totalMisses = slop.length - perMode.aggressive;
    const bucketed = Object.values(buckets).reduce((a, v) => a + v.length, 0);
    expect(bucketed).toBe(totalMisses);
    // Documented reality, not aspiration: aggressive still misses live slop
    // (metadata-only ceiling). Pin that the sample is honest about it.
    expect(perMode.aggressive).toBeLessThan(slop.length);
  });
});
