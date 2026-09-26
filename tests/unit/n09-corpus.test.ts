import { describe, expect, it } from 'vitest';
import { classifyCandidate } from '@/detection/engine';
import { decide } from '@/policy/decide';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import type { Classification } from '@/domain/classification';
import type { NormalizedVideoCandidate } from '@/domain/video';

/**
 * N09 — detector benchmark over a hand-authored development & regression
 * corpus (210 cases). NOT held-out: labels were authored alongside the rules
 * by the same developers, so these numbers characterize current behavior;
 * they are NOT an independent evaluation of real-world accuracy (V4-01).
 *
 * Labeling contract (hand-authored developer labels, not machine truth):
 * - `ai`   = the CONTENT is materially AI-generated/synthetic (production).
 * - `slop` = the content is automated/low-effort/repetitive (slop dimension).
 * - A case can be ai=true, slop=true, or both — the axes are independent,
 *   matching the product's two-dimension model.
 * - Disclosed-but-synthetic content is labeled ai=true regardless of
 *   disclosure (disclosure is evidence, not a policy pass).
 * - AI-ABOUT content (reviews, tutorials, news) is labeled ai=false.
 * - Missing/ambiguous metadata is labeled ai=false + slop=false with an
 *   `expectVisible` note: the honest outcome is allow (metadata absence is
 *   never evidence), so these measure the false-positive side.
 *
 * Reported metrics (with explicit denominators):
 * - AI axis:  precision, recall, false-positive rate. Prediction uses the AI
 *   dimension ONLY (never max(ai, slop) — that conflation hid axis errors).
 * - Slop axis: precision, recall, false-positive rate. Precision/recall are
 *   reported as n/a (null) when their denominator is zero — never fabricated
 *   as 1.000 (v3 reported precision=1.000 with tp=0 and fp=0).
 * - Per-surface slice (home/search/shorts/watch) and prediction coverage:
 *   the share of cases where the engine produced ANY category signal
 *   (unknown-vs-allow); a low-coverage corpus would make metric floors
 *   vacuous.
 *
 * These thresholds pin the CURRENT documented behavior; regressions in the
 * engine surface here as metric drops, before users see them.
 */

type Surface = NormalizedVideoCandidate['surface'];
const SURFACES_FOR_SLICE: readonly Surface[] = ['home', 'search', 'shorts-feed', 'watch-sidebar'];

interface CorpusCase {
  /** Unique id for regression tracing (N19 miss taxonomy). */
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  /** Human label: content is materially AI-generated. */
  readonly ai: boolean;
  /** Human label: content is automated/low-effort/slop. */
  readonly slop: boolean;
  /** YouTube "Altered or synthetic" label present on the real card. */
  readonly ytLabel?: boolean | undefined;
  readonly isShort?: boolean | undefined;
  readonly surface?: Surface | undefined;
  /** Locale hint of the content (multilingual slice). */
  readonly locale?: string | undefined;
  /** Buckets used for coverage reporting. */
  readonly bucket:
    | 'disclosed-ai'
    | 'undisclosed-ai'
    | 'ai-music'
    | 'human-animation'
    | 'ai-assisted-human'
    | 'ai-discussion'
    | 'satire'
    | 'clickbait-no-ai'
    | 'multilingual-ai'
    | 'multilingual-human'
    | 'shorts-ai'
    | 'shorts-human'
    | 'missing-metadata'
    | 'ambiguous';
}

/** Build the corpus programmatically-composed of literal title strings. */
function C(
  id: string,
  title: string,
  bucket: CorpusCase['bucket'],
  labels: {
    ai?: boolean;
    slop?: boolean;
    ytLabel?: boolean;
    isShort?: boolean;
    surface?: Surface;
    locale?: string;
    description?: string;
  },
): CorpusCase {
  return {
    id,
    title,
    bucket,
    ai: labels.ai ?? false,
    slop: labels.slop ?? false,
    ytLabel: labels.ytLabel,
    isShort: labels.isShort,
    surface: labels.surface,
    locale: labels.locale,
    description: labels.description,
  };
}

export const CORPUS: readonly CorpusCase[] = [
  // ── Disclosed AI (official label or creator disclosure) — 45 cases ──────
  C('c001', 'Cute Fruit Babies Eating | AI Generated Funny Fruits Animation', 'disclosed-ai', {
    ai: true,
  }),
  C('c002', 'Satisfying Glass-Like Watermelon Bites | ASMR (AI-Generated)', 'disclosed-ai', {
    ai: true,
  }),
  C(
    'c003',
    'Foodtrip muna ng Lava Chocolate Cake!! ai generated tagalog video using veo 3! #ai',
    'disclosed-ai',
    { ai: true, locale: 'fil' },
  ),
  C('c004', 'Tutorial: all footage in this video was generated with Sora', 'disclosed-ai', {
    ai: true,
    description: 'All footage in this video was generated with Sora.',
  }),
  C('c005', 'Music generated using Suno', 'ai-music', { ai: true }),
  C('c006', 'Relaxing 3 hours of calming ocean scenes (made with AI)', 'disclosed-ai', {
    ai: true,
  }),
  C('c007', 'I made this entire film with Runway', 'disclosed-ai', { ai: true }),
  C('c008', 'AI animation cat video #cat #pets #3danimation', 'disclosed-ai', {
    ai: true,
    isShort: true,
  }),
  C('c009', 'ORANGE Baby #ai #comedy #baby #shorts', 'undisclosed-ai', { ai: true, isShort: true }),
  C('c010', 'Created with OpenAI Sora — dream city walkthrough', 'disclosed-ai', { ai: true }),
  C('c011', 'This video was made using Veo 3', 'disclosed-ai', {
    ai: true,
    description: 'This video was made using Veo 3.',
  }),
  C('c012', 'Generative AI short film: The Last Bus', 'disclosed-ai', { ai: true }),
  C('c013', 'Midjourney storyboard to full scene — AI visuals only', 'disclosed-ai', {
    ai: true,
    description: 'The visuals in this video are AI generated.',
  }),
  C('c014', 'Gawa sa AI: Kwento ni Lolo', 'disclosed-ai', { ai: true, locale: 'fil' }),
  C('c015', 'AI na boses: Tagalog bedtime stories', 'ai-music', { ai: true, locale: 'fil' }),
  C('c016', 'Synthesia explainer (fully AI avatar present)', 'disclosed-ai', { ai: true }),
  C('c017', 'HeyGen avatar news recap — AI generated video', 'disclosed-ai', { ai: true }),
  C('c018', 'Sleep story visuals generated using AI', 'disclosed-ai', { ai: true }),
  C('c019', '10 hours of AI generated fireplace', 'disclosed-ai', { ai: true }),
  C('c020', 'ASMR glass cutting (visuals AI generated)', 'disclosed-ai', { ai: true }),
  C('c021', 'Askew caf\u00e9 scene \u2014 made with AI video tools', 'disclosed-ai', { ai: true }),
  C('c022', 'Ai animation dog rescue part 12', 'disclosed-ai', { ai: true, isShort: true }),
  C('c023', ' Asked ChatGPT to write this, visuals by Pika', 'disclosed-ai', { ai: true }),
  C('c024', 'AI generated tagalog kwento: Ang Mahiwagang Baul', 'disclosed-ai', {
    ai: true,
    locale: 'fil',
  }),
  C('c025', 'Stable Diffusion animation reel', 'disclosed-ai', { ai: true }),
  C('c026', 'DALL-E art timelapse (AI-generated imagery)', 'disclosed-ai', { ai: true }),
  C('c027', 'The visuals are AI generated; commentary is mine', 'disclosed-ai', {
    ai: true,
    description: 'The visuals in this video are AI generated.',
  }),
  C('c028', 'Fully synthetic influencer \u2014 AI voiceover by ElevenLabs', 'disclosed-ai', {
    ai: true,
    description: 'This video uses an AI voice over generated with ElevenLabs.',
  }),
  C('c029', 'AI sung cover of a classic ballad', 'ai-music', { ai: true }),
  C('c030', 'Suno song: Neon Rain (AI music)', 'ai-music', { ai: true }),
  C('c031', 'Udio track \u2014 generated using AI', 'ai-music', { ai: true }),
  C('c032', 'Lofi beats generated with Suno AI', 'ai-music', { ai: true }),
  C('c033', 'AI made song for my dog\u2019s birthday', 'ai-music', { ai: true }),
  C('c034', 'Vegetable animals parade (AI Generated)', 'disclosed-ai', { ai: true }),
  C('c035', 'Giant produce ASMR \u2014 AI-generated visuals', 'disclosed-ai', { ai: true }),
  C('c036', '_synthetic weather reporter reads fake news (AI)', 'disclosed-ai', { ai: true }),
  C('c037', 'Gawa ng AI: barrio love story ep 1', 'disclosed-ai', { ai: true, locale: 'fil' }),
  C('c038', 'Podcast entirely with AI voices', 'disclosed-ai', {
    ai: true,
    description: 'Automated voice over generated using AI.',
  }),
  C('c039', 'Fake movie trailer made with AI tools', 'disclosed-ai', { ai: true }),
  C('c040', 'AI-generated product demo (fictional gadget)', 'disclosed-ai', { ai: true }),
  C('c041', 'Imaginary travel vlog of a country that does not exist (AI)', 'disclosed-ai', {
    ai: true,
  }),
  C('c042', 'Altered or synthetic content badge: shape-shifting pet', 'disclosed-ai', {
    ai: true,
    ytLabel: true,
  }),
  C('c043', 'YT-labeled synthetic: bouncing fruit city', 'disclosed-ai', {
    ai: true,
    ytLabel: true,
  }),
  C('c044', 'Labeled altered content: impossible waterfall hike', 'disclosed-ai', {
    ai: true,
    ytLabel: true,
  }),
  C('c045', 'YT synthetic label: baby professor lecture', 'disclosed-ai', {
    ai: true,
    ytLabel: true,
  }),

  // ── Undisclosed likely AI (title/context signals) — 25 cases ────────────
  C('c046', 'AI baby reciting papa poem', 'undisclosed-ai', { ai: true }),
  C('c047', '3D animation: Fruit village ep 4', 'undisclosed-ai', { ai: true }),
  C('c048', 'I asked Gemini to run a city', 'undisclosed-ai', { ai: true }),
  C('c049', 'Talking fruit orchestra part 7', 'undisclosed-ai', { ai: true }),
  C('c050', '4 hours of calming rainy street scenes', 'undisclosed-ai', { ai: true }),
  C('c051', 'Same video again for the 50th time?', 'undisclosed-ai', { ai: false, slop: true }),
  C('c052', 'Identical clip again (day 90)', 'undisclosed-ai', { ai: false, slop: true }),
  C('c053', 'content farm marathon: 100 facts in 10 minutes', 'undisclosed-ai', {
    ai: false,
    slop: true,
  }),
  C('c054', 'You won\u2019t believe what this cat did next', 'clickbait-no-ai', {
    ai: false,
    slop: true,
  }),
  C('c055', 'Top 10 shocking moments caught on tape', 'clickbait-no-ai', { ai: false, slop: true }),
  C('c056', 'Scientists hate this one weird trick', 'clickbait-no-ai', { ai: false, slop: true }),
  C('c057', 'Hindi ka maniniwala sa nangyari!', 'clickbait-no-ai', {
    ai: false,
    slop: true,
    locale: 'fil',
  }),
  C('c058', 'Ai animation baby dance super', 'undisclosed-ai', { ai: true, isShort: true }),
  C('c059', 'AI babies go shopping #shorts', 'undisclosed-ai', { ai: true, isShort: true }),
  C('c060', 'Synthetic paradise island tour (no disclosure)', 'undisclosed-ai', { ai: true }),
  C('c061', 'Endless robot factory loop video', 'undisclosed-ai', { ai: true }),
  C('c062', 'Binaural sleep rain 8 hours relaxing views', 'undisclosed-ai', { ai: true }),
  C('c063', 'ChatGPT wrote this movie plot', 'undisclosed-ai', { ai: true }),
  C('c064', 'Bakit laging AI ang boses? AI narration test', 'undisclosed-ai', {
    ai: true,
    locale: 'fil',
  }),
  C('c065', 'Pika labs demo: floating cities', 'undisclosed-ai', { ai: true }),
  C('c066', 'Runway gen-2 cinematic b-roll pack', 'undisclosed-ai', { ai: true }),
  C('c067', 'Ambiguous art style \u2014 is it AI? You decide', 'ambiguous', { ai: false }),
  C('c068', 'This took 40 hours in Blender (painted frame by frame)', 'human-animation', {
    ai: false,
  }),
  C('c069', 'Hand-drawn animation process \u2014 no AI involved', 'human-animation', { ai: false }),

  // ── Human animation / crafted content — 25 cases ────────────────────────
  C('c070', 'Pixar-style short film (studio production)', 'human-animation', { ai: false }),
  C('c071', 'Stop motion claymation: kitchen band', 'human-animation', { ai: false }),
  C('c072', 'Claymation fruit babies (real clay, real hands)', 'human-animation', { ai: false }),
  C('c073', 'Minecraft animation series ep 12', 'human-animation', { ai: false }),
  C('c074', 'Sims 4 story: my legacy challenge', 'human-animation', { ai: false }),
  C('c075', 'Garry\u2019s Mod animation: props at war', 'human-animation', { ai: false }),
  C('c076', '3D animation showreel 2024 (Blender)', 'human-animation', { ai: false }),
  C('c077', 'My 2D animation portfolio', 'human-animation', { ai: false }),
  C('c078', 'Ray-traced architectural walkthrough', 'human-animation', { ai: false }),
  C('c079', 'Unreal Engine cinematic \u2014 fan project', 'human-animation', { ai: false }),
  C('c080', 'Animatic: storyboards to screen', 'human-animation', { ai: false }),
  C('c081', 'Handmade miniatures: tiny bakery timelapse', 'human-animation', { ai: false }),
  C('c082', 'Puppet building for stop motion', 'human-animation', { ai: false }),
  C('c083', 'Wooden automata: mechanical bird', 'human-animation', { ai: false }),
  C('c084', 'Practical effects: mini explosion rig', 'human-animation', { ai: false }),
  C('c085', 'Model railway journey (real trains, real set)', 'human-animation', { ai: false }),
  C('c086', 'Thai railway market \u2014 real footage', 'human-animation', { ai: false }),
  C('c087', 'Daily rain recording from my window', 'human-animation', { ai: false }),
  C('c088', 'Said nothing in particular (lofi practice)', 'human-animation', { ai: false }),
  C('c089', 'My grandmother\u2019s 90th birthday party', 'human-animation', { ai: false }),
  C('c090', 'Live acoustic set at the corner caf\u00e9', 'human-animation', { ai: false }),
  C('c091', 'Watercolor painting timelapse', 'human-animation', { ai: false }),
  C('c092', 'Woodworking: hand-cut dovetails', 'human-animation', { ai: false }),
  C('c093', 'Real baking: croissant lamination', 'human-animation', { ai: false }),
  C('c094', 'Garden tour \u2014 summer update', 'human-animation', { ai: false }),

  // ── AI-assisted human work (AI tools, human content) — 20 cases ─────────
  C('c095', 'How I color-grade with AI plugins (my footage)', 'ai-assisted-human', { ai: false }),
  C('c096', 'I used AI to clean up my audio \u2014 still my video', 'ai-assisted-human', {
    ai: false,
  }),
  C('c097', 'Photoshop generative fill for product shots (my studio)', 'ai-assisted-human', {
    ai: false,
  }),
  C('c098', 'AI upscaling my old family tapes', 'ai-assisted-human', { ai: false }),
  C('c099', 'My stream highlights (auto-edited with AI tools)', 'ai-assisted-human', { ai: false }),
  C('c100', 'AI captions on my lecture recording', 'ai-assisted-human', { ai: false }),
  C('c101', 'Text-to-speech for accessibility on my tutorial', 'ai-assisted-human', { ai: false }),
  C('c102', 'I tested Veo so you don\u2019t have to', 'ai-discussion', { ai: false }),
  C('c103', 'AI video generators compared (2026)', 'ai-discussion', { ai: false }),
  C('c104', 'Which AI writer is best? Full review', 'ai-discussion', { ai: false }),
  C('c105', 'Best AI video generator review', 'ai-discussion', { ai: false }),
  C('c106', 'Cute AI Baby Reciting Papa \u2014 reaction and analysis', 'ai-discussion', {
    ai: false,
  }),
  C('c107', 'How to spot AI-generated videos', 'ai-discussion', { ai: false }),
  C('c108', 'This is NOT AI-generated; practical effects breakdown', 'ai-discussion', {
    ai: false,
  }),
  C('c109', 'Why AI Slop Is Ruining YouTube', 'ai-discussion', { ai: false }),
  C('c110', 'AI regulation hearing: day 2 testimony', 'ai-discussion', { ai: false }),
  C('c111', 'The dangers of generative AI (documentary)', 'ai-discussion', { ai: false }),
  C('c112', 'Tutorial: running a local LLM on your laptop', 'ai-discussion', { ai: false }),
  C('c113', 'How generative AI works \u2014 explained simply', 'ai-discussion', { ai: false }),
  C('c114', 'Paliwanag tungkol sa AI sa edukasyon', 'ai-discussion', { ai: false, locale: 'fil' }),

  // ── Satire / parody / education without AI — 15 cases ───────────────────
  C('c115', 'SNL parody sketch: the evening news', 'satire', { ai: false }),
  C('c116', 'Parody ad: Infomercial for the fork 2.0', 'satire', { ai: false }),
  C('c117', 'Fake documentary (clearly labeled satire)', 'satire', { ai: false }),
  C('c118', 'Deepfake satire: president sings karaoke (labeled parody)', 'satire', { ai: false }),
  C('c119', 'Lip sync battle rehearsal (real person)', 'satire', { ai: false }),
  C('c120', 'History of animation: 1900\u20131950', 'satire', { ai: false }),
  C('c121', 'Film analysis: the Kuleshov effect', 'satire', { ai: false }),
  C('c122', 'Why practical effects still matter', 'satire', { ai: false }),
  C('c123', 'Cooking pasta with an Italian nonna (real)', 'satire', { ai: false }),
  C('c124', 'Wood shop basics: sharpening chisels', 'satire', { ai: false }),
  C('c125', 'Sora game guide (the video game, not the model)', 'satire', { ai: false }),
  C('c126', 'Kakagulat na pangyayari sa amin \u2014 vlog', 'satire', { ai: false, locale: 'fil' }),
  C('c127', 'Unboxing a mechanical keyboard', 'satire', { ai: false }),
  C('c128', 'Marathon training week 8', 'satire', { ai: false }),
  C('c129', 'Reading rainbow of classic poems', 'satire', { ai: false }),

  // ── Multilingual (non-English) — 20 cases ───────────────────────────────
  C('c130', 'Gawa sa AI: Asong superhero', 'multilingual-ai', { ai: true, locale: 'fil' }),
  C('c131', 'AI generated tagalog video: Ang alamat ng saging', 'multilingual-ai', {
    ai: true,
    locale: 'fil',
  }),
  C('c132', 'Inilikha ng AI: Bayanihan scene', 'multilingual-ai', { ai: true, locale: 'fil' }),
  C('c133', 'AI generated kwento ep 5', 'multilingual-ai', { ai: true, locale: 'fil' }),
  C('c134', 'AI na boses na nagkukuwento', 'multilingual-ai', { ai: true, locale: 'fil' }),
  C('c135', 'Tagalog AI video: salamat sa 100k', 'multilingual-ai', { ai: true, locale: 'fil' }),
  C('c136', 'Kain tayo! (real food vlog from Cebu)', 'multilingual-human', {
    ai: false,
    locale: 'fil',
  }),
  C('c137', 'Biyahe tayo: Vigan walking tour', 'multilingual-human', { ai: false, locale: 'fil' }),
  C('c138', 'Resipi ni lola: adobo (tagalog)', 'multilingual-human', { ai: false, locale: 'fil' }),
  C('c139', 'Balita ngayong gabi (real newscast)', 'multilingual-human', {
    ai: false,
    locale: 'fil',
  }),
  C(
    'c140',
    '\u30a2\u30cb\u30e1\u30fc\u30b7\u30e7\u30f3\u4f5c\u308a\u65b9\u89e3\u8aac (real animation tutorial)',
    'multilingual-human',
    { ai: false, locale: 'ja' },
  ),
  C('c141', '\u624b\u63cf\u304d\u30a2\u30cb\u30e1\u4f5c\u696d\u30ed\u30b0', 'multilingual-human', {
    ai: false,
    locale: 'ja',
  }),
  C('c142', 'C\u00f3mo hacer pan casero (receta real)', 'multilingual-human', {
    ai: false,
    locale: 'es',
  }),
  C('c143', 'Mi viaje a Cusco \u2014 vlog', 'multilingual-human', { ai: false, locale: 'es' }),
  C('c144', 'Reparaci\u00f3n de bicicletas: gu\u00eda b\u00e1sica', 'multilingual-human', {
    ai: false,
    locale: 'es',
  }),
  C(
    'c145',
    'AI\u52d5\u753b\u4f5c\u6210\u65b9\u6cd5\uff08\u65e5\u672c\u8a9e\uff09',
    'multilingual-ai',
    { ai: true, locale: 'ja' },
  ),
  C(
    'c146',
    '\u5b8c\u5168\u306a\u308bAI\u6620\u50cf\u3067\u4f5c\u308b\u77ed\u7de8',
    'multilingual-ai',
    { ai: true, locale: 'ja' },
  ),
  C('c147', 'V\u00eddeo hecho con IA: ciudad flotante', 'multilingual-ai', {
    ai: true,
    locale: 'es',
  }),
  C('c148', 'Historia generada con IA (espa\u00f1ol)', 'multilingual-ai', {
    ai: true,
    locale: 'es',
  }),
  C('c149', 'Canci\u00f3n generada con Suno', 'multilingual-ai', { ai: true, locale: 'es' }),

  // ── Shorts slices — 15 cases ────────────────────────────────────────────
  C('c150', 'Kitchen hacks #shorts (real cooking)', 'shorts-human', {
    ai: false,
    isShort: true,
    surface: 'shorts-feed',
  }),
  C('c151', 'Puppy learns to fetch #shorts', 'shorts-human', {
    ai: false,
    isShort: true,
    surface: 'shorts-feed',
  }),
  C('c152', 'Street performer shreds guitar #shorts', 'shorts-human', {
    ai: false,
    isShort: true,
    surface: 'shorts-feed',
  }),
  C('c153', 'My morning routine #shorts', 'shorts-human', {
    ai: false,
    isShort: true,
    surface: 'shorts-feed',
  }),
  C('c154', 'Skate line at the pier #shorts', 'shorts-human', {
    ai: false,
    isShort: true,
    surface: 'shorts-feed',
  }),
  C('c155', 'AI baby chef #shorts #ai', 'shorts-ai', {
    ai: true,
    isShort: true,
    surface: 'shorts-feed',
  }),
  C('c156', 'Talking vegetables #shorts (3d animation)', 'shorts-ai', {
    ai: true,
    isShort: true,
    surface: 'shorts-feed',
  }),
  C('c157', 'AI generated waterfall hike #shorts', 'shorts-ai', {
    ai: true,
    isShort: true,
    surface: 'shorts-feed',
  }),
  C('c158', 'Synthetic baby professor #shorts', 'shorts-ai', {
    ai: true,
    isShort: true,
    surface: 'shorts-feed',
  }),
  C('c159', 'Fruit babies dance off #shorts (AI Generated)', 'shorts-ai', {
    ai: true,
    isShort: true,
    surface: 'shorts-feed',
  }),
  C('c160', 'News explainer #shorts (real reporter)', 'shorts-human', {
    ai: false,
    isShort: true,
    surface: 'shorts-feed',
  }),
  C('c161', 'Quick recipe: garlic noodles #shorts', 'shorts-human', {
    ai: false,
    isShort: true,
    surface: 'shorts-feed',
  }),
  C('c162', 'Camera settings in 60 seconds #shorts', 'shorts-human', {
    ai: false,
    isShort: true,
    surface: 'shorts-feed',
  }),
  C('c163', 'Tool tips: perfect dovetail #shorts', 'shorts-human', {
    ai: false,
    isShort: true,
    surface: 'shorts-feed',
  }),
  C('c164', 'Horse meets donkey #shorts (real farm)', 'shorts-human', {
    ai: false,
    isShort: true,
    surface: 'shorts-feed',
  }),

  // ── Missing metadata / ambiguous — 16 cases ─────────────────────────────
  C('c165', '', 'missing-metadata', {}),
  C('c166', 'Untitled stream replay', 'missing-metadata', {}),
  C('c167', 'Video', 'missing-metadata', {}),
  C('c168', '(no title available)', 'missing-metadata', {}),
  C('c169', 'IMG_2047', 'missing-metadata', {}),
  C('c170', 'VID_20240107_183445', 'missing-metadata', {}),
  C('c171', 'Screenshot 2024-01-07 at 18.34', 'missing-metadata', {}),
  C('c172', 'New recording 12', 'missing-metadata', {}),
  C('c173', 'Clip 3 final FINAL v2', 'missing-metadata', {}),
  C('c174', 'Untitled design', 'missing-metadata', {}),
  C('c175', 'Is this real or AI?', 'ambiguous', {}),
  C('c176', 'Real or fake? Comment below', 'ambiguous', {}),
  C('c177', 'You decide: art or machine?', 'ambiguous', {}),
  C('c178', 'Mind-blowing clip of the day', 'ambiguous', { slop: false }),
  C('c179', 'Wait for it\u2026 #viral', 'ambiguous', { slop: true }),
  C('c180', 'This changed everything', 'ambiguous', { slop: true }),

  // ── Extra clickbait-without-AI + slop (no AI) — 15 cases ────────────────
  C('c181', '10 facts that will shock you (number 7 is wild)', 'clickbait-no-ai', { slop: true }),
  C('c182', 'Top 10 shocking body transformations', 'clickbait-no-ai', { slop: true }),
  C('c183', '20 life hacks you need right now', 'clickbait-no-ai', { slop: true }),
  C('c184', 'This one trick will change your morning', 'clickbait-no-ai', { slop: true }),
  C('c185', 'Celebrity reacts to viral moment (compilation)', 'clickbait-no-ai', { slop: true }),
  C('c186', 'Compilation: best fails of 2024', 'clickbait-no-ai', { slop: true }),
  C('c187', 'Compilaci\u00f3n de momentos graciosos', 'clickbait-no-ai', {
    slop: true,
    locale: 'es',
    surface: 'search',
  }),
  C('c188', 'Same clip again for the 12th time (channel marathon)', 'clickbait-no-ai', {
    slop: true,
  }),
  C('c189', 'Volume factory: 50 videos a day challenge', 'clickbait-no-ai', { slop: true }),
  C('c190', 'Compilaci\u00f3n: los mejores momentos del a\u00f1o', 'clickbait-no-ai', {
    slop: true,
    locale: 'es',
    surface: 'search',
  }),
  C('c191', 'My honest review of this camera', 'ai-discussion', { surface: 'search' }),
  C('c192', 'Why I stopped using AI tools for editing', 'ai-discussion', { surface: 'search' }),
  C('c193', 'The future of animation (interview with an animator)', 'ai-discussion', {
    surface: 'search',
  }),
  C('c194', 'AI ethics panel discussion (full recording)', 'ai-discussion', { surface: 'search' }),
  C('c195', 'Student film: The Waiting Room (2024)', 'human-animation', {
    surface: 'watch-sidebar',
  }),

  // ── Balance tail: mixed real-world titles — 15 cases ────────────────────
  C('c196', 'Fixing a 1970s amplifier', 'human-animation', { surface: 'watch-sidebar' }),
  C('c197', 'Beekeeping: autumn hive check', 'human-animation', { surface: 'watch-sidebar' }),
  C('c198', 'Learning pottery on a wheel', 'human-animation', { surface: 'watch-sidebar' }),
  C('c199', 'City timelapse (real footage, real year)', 'human-animation', {
    surface: 'watch-sidebar',
  }),
  C('c200', 'Trail running the ridge at sunrise', 'human-animation', { surface: 'watch-sidebar' }),
  C('c201', 'Origami dragon (step by step)', 'human-animation', { surface: 'search' }),
  C('c202', 'Restoring a rusty hand plane', 'human-animation', { surface: 'search' }),
  C('c203', 'Volcano eruption filmed from a boat', 'human-animation', { surface: 'search' }),
  C('c204', 'Classical guitar: Asturias (Leyenda)', 'human-animation', { surface: 'search' }),
  C('c205', 'Wildlife hide: kingfisher dives', 'human-animation', { surface: 'watch-sidebar' }),
  C('c206', 'AI-generated lofi radio (24/7)', 'disclosed-ai', { ai: true, surface: 'search' }),
  C('c207', 'Synthwave album made with AI', 'ai-music', { ai: true, surface: 'search' }),
  C('c208', 'Robot barista serves coffee (fully AI video)', 'undisclosed-ai', {
    ai: true,
    surface: 'watch-sidebar',
  }),
  C('c209', 'Impossible physics simulation \u2014 made with AI', 'undisclosed-ai', {
    ai: true,
    surface: 'watch-sidebar',
  }),
  C('c210', 'Bali villa tour (hosted by an AI avatar)', 'undisclosed-ai', {
    ai: true,
    surface: 'watch-sidebar',
  }),
];

// ---- evaluation harness ----------------------------------------------------

function candidateOf(c: CorpusCase): NormalizedVideoCandidate {
  return {
    videoId: `n09-${c.id}`,
    title: c.title,
    description: c.description,
    channel: { channelId: 'UCN09Corpus000000000000', displayName: 'Corpus Channel' },
    surface: c.surface ?? 'home',
    cardKind: c.isShort ? 'shorts-video' : 'video',
    badges: [],
    ariaLabels: [],
    metadataText: ['12K views', '3 weeks ago'],
    ...(c.ytLabel
      ? { officialDisclosure: { present: true, text: 'Altered or synthetic content' } }
      : {}),
    isShort: c.isShort ?? false,
    observedAt: 1_700_000_000_000,
  };
}

async function classify(c: CorpusCase): Promise<Classification> {
  return classifyCandidate(candidateOf(c), { locale: c.locale });
}

/** V4-01/V4-03 root cause fixed: the mode actually varies policy inputs. */
function settingsFor(mode: UserSettings['mode']): UserSettings {
  return { ...defaultSettings(), mode };
}

function decideAction(
  c: CorpusCase,
  classification: Classification,
  mode: UserSettings['mode'],
): 'allow' | 'warn' | 'hide' {
  return decide({
    settings: settingsFor(mode),
    rules: defaultRules(),
    candidate: {
      videoId: `n09-${c.id}`,
      channelId: 'UCN09Corpus000000000000',
      title: c.title,
    },
    classification,
  }).action;
}

interface Metrics {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  /** Labeled cases evaluated (tp+fp+fn+tn) — the reported denominator. */
  readonly total: number;
  /** Cases where the predictor said positive (tp+fp); 0 ⇒ precision n/a. */
  readonly predictedPositive: number;
  /** tp/(tp+fp), or null when there are NO positive predictions. */
  readonly precision: number | null;
  /** tp/(tp+fn), or null when there are NO labeled positives. */
  readonly recall: number | null;
  /** fp/(fp+tn), or null when there are NO labeled negatives. */
  readonly falsePositiveRate: number | null;
}

/**
 * Real confusion-matrix helper (v3 left it void'ed and inlined its counting).
 * Precision/recall/FPR are null — never 1.000/0.000 — when their denominator
 * is empty (V4-01 benchmark truth).
 */
function metricsOf(
  cases: readonly CorpusCase[],
  axis: 'ai' | 'slop',
  cls: ReadonlyMap<string, Classification>,
  predict: (c: CorpusCase, cl: Classification) => boolean,
): Metrics {
  void axis;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const c of cases) {
    const cl = cls.get(c.id);
    if (!cl) throw new Error(`unclassified case ${c.id}`);
    const positive = predict(c, cl);
    if (c[axis] && positive) tp += 1;
    else if (!c[axis] && positive) fp += 1;
    else if (c[axis] && !positive) fn += 1;
    else tn += 1;
  }
  return {
    tp,
    fp,
    fn,
    tn,
    total: tp + fp + fn + tn,
    predictedPositive: tp + fp,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
    falsePositiveRate: fp + tn === 0 ? null : fp / (fp + tn),
  };
}

function fmt(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3);
}

describe('N09 corpus composition', () => {
  it('has at least 210 cases', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(210);
  });

  it('is balanced across the AI and slop axes (denominators reported)', () => {
    const aiTrue = CORPUS.filter((c) => c.ai).length;
    const slopTrue = CORPUS.filter((c) => c.slop).length;
    const aiFalse = CORPUS.length - aiTrue;
    // Neither axis may dominate: both positives and negatives must be
    // substantial (a 90/10 split would make metrics meaningless).
    expect(aiTrue).toBeGreaterThanOrEqual(60);
    expect(aiFalse).toBeGreaterThanOrEqual(60);
    expect(slopTrue).toBeGreaterThanOrEqual(18);
    // Every case has a bucket.
    for (const c of CORPUS) expect(c.bucket.length).toBeGreaterThan(0);
  });
});

describe('N09 detector metrics (hand-authored dev corpus — not held-out)', () => {
  // AI-axis prediction: the AI dimension ONLY, at the strict-mode hide score
  // gate (0.45). Scores are heuristic rule weights, NOT calibrated
  // probabilities; the threshold pins the documented engine behavior.
  const AI_PREDICT_THRESHOLD = 0.45;

  it('classifies every case and computes AI-axis metrics (AI dimension only)', async () => {
    const cls = new Map<string, Classification>();
    for (const c of CORPUS) cls.set(c.id, await classify(c));

    const m = metricsOf(CORPUS, 'ai', cls, (_c, cl) => cl.aiLikelihood >= AI_PREDICT_THRESHOLD);

    const falseHides: string[] = [];
    const missed: string[] = [];
    for (const c of CORPUS) {
      const cl = cls.get(c.id);
      if (!cl) throw new Error('unclassified');
      const positive = cl.aiLikelihood >= AI_PREDICT_THRESHOLD;
      if (!c.ai && positive) falseHides.push(`${c.id}:${c.title}`);
      if (c.ai && !positive) missed.push(`${c.id}:${c.title}`);
    }

    // Reported denominators (N09: no denominator tricks).
    console.log(
      `N09 AI-axis: n=${m.total} tp=${m.tp} fp=${m.fp} fn=${m.fn} tn=${m.tn} ` +
        `precision=${fmt(m.precision)} recall=${fmt(m.recall)} fpr=${fmt(m.falsePositiveRate)} ` +
        `predictedPositive=${m.predictedPositive}`,
    );
    console.log(`falseHides=${falseHides.join(' | ')}\nmissed=${missed.join(' | ')}`);

    // The metadata-only ceiling is documented: recall is bounded because
    // undisclosed AI carries no observable signal. Floors pin regression:
    expect(m.recall).not.toBeNull();
    expect(m.recall as number).toBeGreaterThanOrEqual(0.45);
    // The product's hard requirement: NO false AI predictions on human content.
    expect(m.fp).toBe(0);
    // Precision is UNDEFINED when the predictor makes no positive predictions
    // — it must never be reported as a number in that case (v3 reported 1.000
    // for tp=fp=0; V4-01 forbids fabricated metrics).
    if (m.predictedPositive === 0) {
      expect(m.precision).toBeNull();
    } else {
      expect(m.precision as number).toBeGreaterThanOrEqual(0.9);
    }
    // Every corpus case contributes to exactly one cell of the matrix.
    expect(m.total).toBe(CORPUS.length);
  });

  it('computes slop-axis metrics with explicit denominators and n/a precision', async () => {
    const slopCases = CORPUS.filter(
      (c) =>
        c.slop ||
        c.bucket === 'clickbait-no-ai' ||
        c.bucket === 'ai-discussion' ||
        c.bucket === 'human-animation',
    );
    const cls = new Map<string, Classification>();
    for (const c of slopCases) cls.set(c.id, await classify(c));
    const m = metricsOf(slopCases, 'slop', cls, (_c, cl) => cl.slopLikelihood >= 0.3);
    console.log(
      `N09 slop-axis: n=${m.total} tp=${m.tp} fp=${m.fp} fn=${m.fn} tn=${m.tn} ` +
        `precision=${fmt(m.precision)} recall=${fmt(m.recall)} fpr=${fmt(m.falsePositiveRate)}`,
    );
    // A slop false positive must never hide human content (hard gate).
    expect(m.fp).toBe(0);
    // Zero positive predictions ⇒ precision is undefined; we must NOT report
    // a fabricated 1.000 (v3 slop axis printed precision=1.000 at tp=0, fp=0).
    if (m.predictedPositive === 0) expect(m.precision).toBeNull();
  });

  it('coverage: per-surface slices non-trivial + prediction-coverage reported', async () => {
    for (const surface of SURFACES_FOR_SLICE) {
      const slice = CORPUS.filter((c) => (c.surface ?? 'home') === surface);
      // home is the default surface; the others have explicit slices.
      if (surface !== 'home') expect(slice.length).toBeGreaterThan(0);
    }
    // Prediction coverage (V4-01): the share of cases where the engine
    // produced ANY category signal. Without this denominator the metric
    // floors above are vacuous — a classifier that signals on nothing
    // trivially passes a recall floor on a corpus it never engages with.
    let withSignal = 0;
    for (const c of CORPUS) {
      const cl = await classify(c);
      if (Object.keys(cl.categories).length > 0 || cl.evidence.length > 0) withSignal += 1;
    }
    const coverage = withSignal / CORPUS.length;
    console.log(
      `N09 coverage: withSignal=${withSignal}/${CORPUS.length} coverage=${coverage.toFixed(3)}`,
    );
    // Floor pins non-vacuity + guards against regressions; the measured
    // value is 0.405 (85/210) — the engine is metadata-blind on ~60% of
    // cases, which IS the documented undisclosed-content ceiling. The floor
    // is a regression tripwire, not a claim of adequacy.
    expect(coverage).toBeGreaterThanOrEqual(0.35);
  });

  it('policy layer: mode ladder is monotonic (strict ≥ balanced ≥ safe hides)', async () => {
    const cls = new Map<string, Classification>();
    for (const c of CORPUS) cls.set(c.id, await classify(c));
    const hides: Record<UserSettings['mode'], number> = {
      safe: 0,
      balanced: 0,
      strict: 0,
      aggressive: 0,
    };
    const strictFalseHides: string[] = [];
    for (const c of CORPUS) {
      const cl = cls.get(c.id);
      if (!cl) throw new Error('unclassified');
      for (const mode of ['safe', 'balanced', 'strict', 'aggressive'] as const) {
        if (decideAction(c, cl, mode) === 'hide') hides[mode] += 1;
      }
      // Decision-level false-hide gate in strict: a case labeled neither AI
      // nor slop (human/ambiguous/unknown buckets) must never be hidden.
      if (!c.ai && !c.slop && decideAction(c, cl, 'strict') === 'hide') {
        strictFalseHides.push(`${c.id}:${c.title}`);
      }
    }
    console.log(
      `N09 policy: safeHides=${hides.safe} balancedHides=${hides.balanced} strictHides=${hides.strict} aggressiveHides=${hides.aggressive}`,
    );
    // Monotonic ladder. v3 named this "strict hides strictly more than safe"
    // while settingsFor ignored the mode entirely (all modes ran balanced
    // defaults); the honest invariant is non-strict monotonicity across the
    // mode ladder, which holds structurally (nested hide-confidence sets,
    // decreasing hideAt). Genuine strictness gains are measured separately on
    // a frozen evaluation set (V4-03), not asserted on the dev corpus.
    expect(hides.strict).toBeGreaterThanOrEqual(hides.balanced);
    expect(hides.balanced).toBeGreaterThanOrEqual(hides.safe);
    expect(strictFalseHides).toEqual([]);
    // Unknowns (missing metadata) stay visible in every mode.
    for (const c of CORPUS.filter((x) => x.bucket === 'missing-metadata')) {
      const cl = cls.get(c.id);
      if (!cl) throw new Error('unclassified');
      for (const mode of ['safe', 'balanced', 'strict', 'aggressive'] as const) {
        expect(decideAction(c, cl, mode)).not.toBe('hide');
      }
    }
  });
});
