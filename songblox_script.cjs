const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const {TextEncoder, TextDecoder} = require('node:util');
const html = fs.readFileSync('/workspace/musikanalyse.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function load(name, next, globals = {}) {
  const start = script.indexOf(`function ${name}(`);
  const end = script.indexOf(`function ${next}(`, start);
  assert.notEqual(start, -1, `${name} helper exists`);
  assert.notEqual(end, -1, `${next} helper exists`);
  const declarations = script.slice(start, end);
  return vm.runInNewContext(`${declarations};globalThis.__loaded=${name};globalThis.__loaded`, {TextEncoder, TextDecoder, btoa, atob, URL, ...globals});
}
test('pointer position maps to bounded timeline time', () => {
  const map = load('mapPointerToTime', 'updateSegmentFromDrag');
  assert.equal(map(150, {left: 100, width: 200}, 100), 25);
  assert.equal(map(50, {left: 100, width: 200}, 100), 0);
  assert.equal(map(400, {left: 100, width: 200}, 100), 100);
});
test('drag moves a segment without changing its length and keeps it in bounds', () => {
  const update = load('updateSegmentFromDrag', 'setVideoVisible');
  assert.deepEqual({...update({start: 20, end: 40}, 'move', 7, 100)}, {start: 27, end: 47});
  assert.deepEqual({...update({start: 20, end: 40}, 'move', 90, 100)}, {start: 80, end: 100});
});
test('resize enforces a minimum one-second segment', () => {
  const update = load('updateSegmentFromDrag', 'setVideoVisible');
  assert.deepEqual({...update({start: 20, end: 40}, 'start', 50, 100)}, {start: 39, end: 40});
  assert.deepEqual({...update({start: 20, end: 40}, 'end', -50, 100)}, {start: 20, end: 21});
});
test('share state round-trips video and Unicode analysis names', () => {
  const encode = load('encodeAnalysisState', 'decodeAnalysisState');
  const decode = load('decodeAnalysisState', 'toast');
  const state = {version: 1, videoUrl: 'https://youtu.be/_t9t0kZRJ54', duration: 222,
    tracks: [{name: 'Rhythmus 🎵', color: '#ff986b'}], nickname: 'Mia',
    segments: [{name: 'Überleitung', start: 10, end: 30, track: 0}]};
  assert.deepEqual(JSON.parse(JSON.stringify(decode(encode(state)))), state);
});
test('invalid shared state is rejected', () => {
  const decode = load('decodeAnalysisState', 'toast');
  assert.equal(decode('not-valid-base64!'), null);
  assert.equal(decode('e30'), null);
});
test('video visibility toggle updates the panel and accessible button state', () => {
  const setVisible = load('setVideoVisible', 'encodeAnalysisState');
  const classes = new Set();
  const video = {classList: {toggle(name, force) { force ? classes.add(name) : classes.delete(name); }}};
  const attributes = {};
  const button = {textContent: '', setAttribute(name, value) { attributes[name] = value; }};
  setVisible(false, video, button);
  assert.equal(classes.has('is-hidden'), true);
  assert.equal(button.textContent, 'Video einblenden');
  assert.equal(attributes['aria-pressed'], 'false');
  setVisible(true, video, button);
  assert.equal(classes.has('is-hidden'), false);
  assert.equal(button.textContent, 'Video ausblenden');
  assert.equal(attributes['aria-pressed'], 'true');
});
test('analysis share payload includes the trimmed nickname', () => {
  const normalize = load('normalizeNickname', 'fitSegmentsToDuration');
  const build = load('buildAnalysisState', 'layoutSummaryBlocks', {normalizeNickname: normalize});
  const state = build('https://youtu.be/_t9t0kZRJ54', 180, [], [], '  Alex  ');
  assert.deepEqual(JSON.parse(JSON.stringify(state)), {
    version: 1, videoUrl: 'https://youtu.be/_t9t0kZRJ54', duration: 180,
    tracks: [], segments: [], nickname: 'Alex'
  });
});
test('nickname removes all whitespace and is limited to eight characters', () => {
  const normalize = load('normalizeNickname', 'fitSegmentsToDuration');
  assert.equal(normalize(' Ab c\tDe123456 '), 'AbcDe123');
  assert.equal(normalize('   '), '');
});
test('video duration keeps every segment inside the actual timeline', () => {
  const fit = load('fitSegmentsToDuration', 'buildTimelineTicks');
  assert.deepEqual(JSON.parse(JSON.stringify(fit([
    {name: 'A', start: 23, end: 59, track: 1},
    {name: 'B', start: 60, end: 94, track: 2}
  ], 50))), [
    {name: 'A', start: 23, end: 50, track: 1},
    {name: 'B', start: 49, end: 50, track: 2}
  ]);
});
test('timeline ticks end at the actual video duration', () => {
  const fmt = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
  const ticks = load('buildTimelineTicks', 'getVisibleTickIndexes', {fmt});
  const result = ticks(222);
  assert.equal(result[0].label, '00:00');
  assert.equal(result.at(-1).label, '03:42');
  assert.equal(result.at(-1).position, 100);
  assert.equal(result.length, 15);
});
test('timeline labels thin out by repeated halving when their measured gaps overlap', () => {
  const stride = load('getTimelineTickStride', 'getResizeHandleWidth');
  const visible = load('getVisibleTickIndexes', 'getTimelineTickStride', {getTimelineTickStride: stride});
  assert.deepEqual(JSON.parse(JSON.stringify(visible(15, 960, 70))), [0, 2, 4, 6, 8, 10, 12, 14]);
  assert.deepEqual(JSON.parse(JSON.stringify(visible(15, 400, 70))), [0, 4, 8, 12, 14]);
});
test('resize hit zones shrink with short blocks but stay capped for long blocks', () => {
  const handleWidth = load('getResizeHandleWidth', 'isSegmentActive');
  assert.equal(handleWidth(16), 6);
  assert.equal(handleWidth(80), 20);
  assert.equal(handleWidth(200), 24);
});
test('only the currently playing segment is marked active', () => {
  const isActive = load('isSegmentActive', 'stopPlaybackOnTrackChange');
  const segment = {start: 10, end: 20};
  assert.equal(isActive(segment, 15, true), true);
  assert.equal(isActive(segment, 20, true), false);
  assert.equal(isActive(segment, 15, false), false);
});
test('switching matrix rows stops playback only when the row changes', () => {
  const stopOnChange = load('stopPlaybackOnTrackChange', 'getInitialSegments');
  let stops = 0;
  assert.equal(stopOnChange(2, 1, () => stops++), true);
  assert.equal(stopOnChange(2, 2, () => stops++), false);
  assert.equal(stops, 1);
});
test('the editor starts with exactly two sample blocks', () => {
  const initial = load('getInitialSegments', 'getOverviewHeight');
  assert.equal(initial().length, 2);
  assert.equal(initial()[0].track, 0);
  assert.equal(initial()[1].track, 1);
});
test('analysis categories use the requested fixed labels', () => {
  const categories = load('getSectionCategories', 'buildAnalysisState');
  assert.deepEqual(JSON.parse(JSON.stringify(categories())), [
    'Intro/Outro', 'Strophe', 'Pre-Chorus', 'Chorus', 'Bridge', 'Spezial'
  ]);
  assert.ok(script.includes("'#f3c76a'"));
});
test('the special matrix row offers its default and all alternate labels', () => {
  const options = load('getTrackLabelOptions', 'getSectionCategories');
  assert.deepEqual(JSON.parse(JSON.stringify(options())), [
    'Spezial', 'Bass', 'Gesang', 'Analysebereich', 'Improvisation'
  ]);
});
test('overview blocks share a row unless their times overlap', () => {
  const layout = load('layoutSummaryBlocks', 'selectTrack');
  assert.deepEqual(JSON.parse(JSON.stringify(layout([
    {start: 20, end: 40}, {start: 0, end: 30}, {start: 40, end: 60}
  ]))), [
    {index: 1, row: 0}, {index: 0, row: 1}, {index: 2, row: 0}
  ]);
});
test('overview tolerates slight overlaps but separates substantial overlaps', () => {
  const layout = load('layoutSummaryBlocks', 'selectTrack');
  assert.deepEqual(JSON.parse(JSON.stringify(layout([
    {start: 0, end: 30}, {start: 29, end: 45}, {start: 42, end: 60}
  ], 2))), [
    {index: 0, row: 0}, {index: 1, row: 0}, {index: 2, row: 1}
  ]);
});
test('overview reserves twice a matrix row height and expands for overlap rows', () => {
  const height = load('getOverviewHeight', 'getOverviewRowMetrics');
  assert.equal(height(1), 68);
  assert.equal(height(2), 94);
  assert.equal(height(3), 120);
});
test('overview overflow rows use half-height blocks below the full-height first row', () => {
  const metrics = load('getOverviewRowMetrics', 'createSegmentAt');
  assert.deepEqual(JSON.parse(JSON.stringify(metrics(0))), {top: 2, height: 48});
  assert.deepEqual(JSON.parse(JSON.stringify(metrics(1))), {top: 52, height: 24});
  assert.deepEqual(JSON.parse(JSON.stringify(metrics(2))), {top: 78, height: 24});
});
test('new section uses the selected category and stays within the video duration', () => {
  const create = load('createSegmentAt', 'removeSegmentAt');
  assert.deepEqual({...create(42, 100, 3, 'Chorus')}, {
    name: 'Chorus', start: 42, end: 62, track: 3
  });
  assert.deepEqual({...create(100, 100, 2, 'Pre-Chorus')}, {
    name: 'Pre-Chorus', start: 99, end: 100, track: 2
  });
});
test('one selected section can be deleted without affecting other sections', () => {
  const remove = load('removeSegmentAt', 'renderRuler');
  assert.deepEqual(JSON.parse(JSON.stringify(remove([
    {name: 'A'}, {name: 'B'}, {name: 'C'}
  ], 1))), [{name: 'A'}, {name: 'C'}]);
});
test('section list order follows the blocks current timeline positions', () => {
  const order = load('getOrderedSections', 'getSectionDisplayName');
  assert.deepEqual(JSON.parse(JSON.stringify(order([
    {name: 'Chorus', start: 40}, {name: 'Verse', start: 10}
  ]).map(section => section.name))), ['Verse', 'Chorus']);
});
test('section list label follows the block current matrix row', () => {
  const displayName = load('getSectionDisplayName', 'isOverviewSegmentActive');
  assert.equal(displayName({name: 'Stale label', track: 2}, [
    {name: 'Intro'}, {name: 'Strophe'}, {name: 'Chorus'}
  ]), 'Chorus');
});
test('first-row sections use Intro, Break, and a final Outro label', () => {
  const display = load('getSectionDisplayName', 'isOverviewSegmentActive');
  const tracks = [{name: 'Intro/Break/Outro'}, {name: 'Strophe'}];
  assert.equal(display({name: 'old', start: 0, track: 0}, tracks), 'Intro');
  const sections = [
    {name: 'old', start: 30, track: 0},
    {name: 'old', start: 0, track: 0},
    {name: 'old', start: 20, track: 1},
    {name: 'old', start: 10, track: 0},
  ];
  assert.equal(display(sections[1], tracks, sections), 'Intro');
  assert.equal(display(sections[3], tracks, sections), 'Break');
  assert.equal(display(sections[0], tracks, sections), 'Outro');
  sections.push({name: 'later', start: 40, track: 1});
  assert.equal(display(sections[0], tracks, sections), 'Break');
});
test('only first-row overview blocks receive active highlighting', () => {
  const active = load('isOverviewSegmentActive', 'getInitialSegments', {isSegmentActive: (segment, time, playing) => playing && time >= segment.start && time < segment.end});
  const segment = {start: 10, end: 20};
  assert.equal(active(0, segment, 15, true), true);
  assert.equal(active(1, segment, 15, true), false);
  assert.equal(active(0, segment, 20, true), false);
});
test('font size control never goes below 100% and scales in ten-percent increments', () => {
  const clamp = load('clampFontStep', 'fontScaleForStep');
  const scale = load('fontScaleForStep', 'getInitialSegments', {clampFontStep: clamp});
  assert.equal(clamp(-8), 0);
  assert.equal(clamp(12), 10);
  assert.equal(scale(-5), 1);
  assert.equal(scale(0), 1);
  assert.equal(scale(1), 1.1);
  assert.equal(scale(10), 2);
});
test('pasting a clipboard link fills the URL without focusing the input', async () => {
  const paste = load('pasteClipboardText', 'normalizeNickname');
  let value = '';
  const result = await paste(async () => '  https://youtu.be/_t9t0kZRJ54  ', text => { value = text; });
  assert.equal(result, true);
  assert.equal(value, 'https://youtu.be/_t9t0kZRJ54');
  assert.equal(await paste(async () => '   ', () => assert.fail('empty clipboard must not replace the URL')), false);
});
test('YouTube link is informational and exposes a clipboard paste control', () => {
  assert.match(html, /<[^>]+id="youtubeUrl"[^>]*class="[^"]*url-display/);
  assert.match(html, /id="pasteUrl"/);
  assert.match(html, /<button id="pasteUrl" class="paste-button" type="button">Hier klicken, um Videolink einzufügen<\/button><div id="youtubeUrl" class="url-display">YouTube-URL<\/div><button id="loadVideo" type="button" disabled>Video laden<\/button>/);
  assert.ok(html.includes('.urlbar #pasteUrl{background:var(--lime)'));
  assert.ok(script.includes("$('#pasteUrl').onclick=async()=>"));
  assert.ok(script.includes('navigator.clipboard.readText()'));
});
test('only valid YouTube video URLs enable the load button', () => {
  const extract = load('getYouTubeVideoId', 'updateLoadVideoState');
  const update = load('updateLoadVideoState', 'encodeAnalysisState', {getYouTubeVideoId: extract});
  const button = {disabled: false, ready: false};
  button.classList = {toggle(name, active) { if (name === 'is-ready') button.ready = active; }};
  assert.equal(update('https://youtu.be/_t9t0kZRJ54', button), '_t9t0kZRJ54');
  assert.equal(button.disabled, false);
  assert.equal(button.ready, true);
  assert.equal(update('https://example.com/watch?v=_t9t0kZRJ54', button), '');
  assert.equal(button.disabled, true);
  assert.equal(button.ready, false);
});
test('section list displays each category label once', () => {
  assert.ok(!script.includes("el.querySelector('.tag').textContent="));
  assert.ok(!script.includes('span class="tag" style="--c:${tracks[s.track]?.color'));
  assert.ok(script.includes('span class="markname"></span>'));
});
test('special track dot stays visible and long labels are clipped in place', () => {
  assert.ok(html.includes('.trackname .dot{display:inline-block;flex:0 0 7px}'));
  assert.ok(html.includes('overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px'));
});
test('font controls use standard buttons and have no explanatory sentence', () => {
  assert.match(html, /id="fontDown"[^>]*>A−<\/button>/);
  assert.match(html, /id="fontUp"[^>]*>A\+<\/button>/);
  assert.ok(!html.includes('Mit A− / A+ lässt sich die Schriftgröße'));
  assert.ok(html.includes('#appTooltip{position:fixed'));
});
test('transport emphasizes play and gives five-second jumps function-key styling', () => {
  assert.match(html, /class="playbtn[^"]*" id="toggle"/);
  assert.match(html, /class="function-key"[^>]*id="back"[^>]*>−5<\/button>/);
  assert.match(html, /class="function-key"[^>]*id="forward"[^>]*>\+5<\/button>/);
  assert.ok(html.includes('.playbtn{'));
  assert.ok(html.includes('.function-key{'));
});
test('matrix editor has a right-aligned overview playback hint', () => {
  const hint = 'Klicke auf einen Block in der Gesamtübersicht, um den Song direkt von dort abzuspielen.';
  const hintPosition = html.indexOf(hint);
  const headingPosition = html.indexOf('ARBEITSBEREICH / ANALYSE');
  const taskPosition = html.indexOf('id="assignmentText"');
  assert.ok(hintPosition >= 0 && hintPosition < headingPosition);
  assert.ok(headingPosition >= 0 && headingPosition < taskPosition);
  assert.ok(html.includes('<div class="matrix-note overview-note">'));
  assert.ok(html.includes('.matrix-note{display:block;width:100%;margin:0;padding:0;border:0;border-radius:0;background:transparent;color:var(--muted);font-size:12px;line-height:1.5;text-align:right'));
  assert.ok(!html.includes('class="matrix-tooltip overview-tooltip"'));
});
test('overview label uses the same typography as Strophe track labels', () => {
  assert.ok(html.includes('.overview-label{font-size:11px;color:#d0d1c8'));
  assert.ok(html.includes('.trackname{font-size:11px;color:#d0d1c8'));
});
test('assignment Markdown is loaded and its visibility control toggles both ways', async () => {
  assert.ok(html.includes("loadMarkdownFile(path=>fetch(path),'./sondblox_aufgabe.md'"));
  assert.match(html, /id="toggleAssignment"[^>]*class="[^"]*feature-toggle[^"]*"[^>]*>Aufgabe ausblenden/);
  assert.ok(html.includes('class="video-toggle feature-toggle" id="videoToggle"'));
  assert.ok(html.includes('.feature-toggle,.transport .feature-toggle{min-height:44px;padding:0 10px;border:1px solid var(--line);border-radius:5px;font-size:12px;white-space:nowrap;background:none;color:#dedfd6}'));
  assert.ok(script.includes("$('#toggleAssignment').onclick=()=>setAssignmentVisible($('#assignmentText').hidden"));
  const loadMarkdownFile = load('loadMarkdownFile', 'loadDescription');
  const target = {textContent: ''};
  let loadedPath = '';
  await loadMarkdownFile(async path => { loadedPath = path; return {ok: true, text: async () => 'Zeile 1\nZeile 2'}; }, './sondblox_aufgabe.md', target, 'Fallback');
  assert.equal(loadedPath, './sondblox_aufgabe.md');
  assert.equal(target.textContent, 'Zeile 1\nZeile 2');
  const setVisible = load('setAssignmentVisible', 'getInitialSegments');
  const text = {hidden: false, parentElement: {classes: new Set(), classList: {toggle(name, force) { force ? this.owner.classes.add(name) : this.owner.classes.delete(name); }}}};
  text.parentElement.classList.owner = text.parentElement;
  const button = {textContent: '', attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }};
  setVisible(false, text, button);
  assert.equal(text.hidden, true);
  assert.equal(button.textContent, 'Aufgabe einblenden');
  assert.equal(button.attributes['aria-expanded'], 'false');
  assert.ok(text.parentElement.classes.has('is-collapsed'));
  setVisible(true, text, button);
  assert.equal(text.hidden, false);
  assert.equal(button.textContent, 'Aufgabe ausblenden');
  assert.ok(!text.parentElement.classes.has('is-collapsed'));
  assert.ok(html.includes('.assignment-box.is-collapsed{min-height:0;flex-direction:row;justify-content:flex-end;align-items:center;gap:0;margin:0;padding:0;border:0;background:transparent}'));
  assert.ok(html.includes('.assignment-box.is-collapsed .assignment-text{display:none}'));
});
test('Markdown text regions preserve line breaks', () => {
  assert.ok(html.includes('.markdown-text{white-space:pre-line}'));
  assert.ok(html.includes('class="short-description markdown-text" id="shortDescription"'));
  assert.ok(html.includes('class="markdown-text assignment-text" id="assignmentText"'));
});
test('description, settings, shortcuts, and author metadata appear in order', () => {
  const description = 'Diese Webanwendung ermöglicht das Untersuchen von Musikvideos, die auf YouTube verfügbar sind: Abschnitte erkennen, miteinander vergleichen, Unterschiede beschreiben und ihre Bedeutung für den musikalischen Verlauf verstehen.';
  const markdown = fs.readFileSync('/workspace/songblox_kurzbeschreibung.md', 'utf8').trim();
  assert.ok(markdown.startsWith(description));
  const positions = [
    html.indexOf('Kurzbeschreibung und Nutzung'),
    html.indexOf('id="shortDescription"'),
    html.indexOf('Einstellungen'),
    html.indexOf('Tastenkürzel'),
    html.indexOf('Matthias Krebs · Version 0.1.0 · 30.10.2026'),
  ];
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.ok(html.includes("loadMarkdownFile(fetchMarkdown,'./songblox_kurzbeschreibung.md'"));
  assert.ok(html.includes("loadDescription(path=>fetch(path)"));
});
test('description loader falls back when the Markdown file cannot be fetched', async () => {
  const loadMarkdownFile = load('loadMarkdownFile', 'loadDescription');
  const loadDescription = load('loadDescription', 'setAssignmentVisible', {loadMarkdownFile});
  const target = {textContent: ''};
  await loadDescription(async () => ({ok: true, text: async () => '  Markdown-Text  '}), target, 'Fallback');
  assert.equal(target.textContent, 'Markdown-Text');
  await loadDescription(async () => { throw new Error('offline'); }, target, 'Fallback');
  assert.equal(target.textContent, 'Fallback');
});
test('font control updates page zoom and disables only at its bounds', () => {
  const clamp = load('clampFontStep', 'fontScaleForStep');
  const scale = load('fontScaleForStep', 'getInitialSegments', {clampFontStep: clamp});
  const update = load('updateFontScale', 'loadDescription', {clampFontStep: clamp, fontScaleForStep: scale});
  const root = {style: {}};
  const output = {textContent: ''};
  const down = {disabled: false};
  const up = {disabled: false};
  let step = update(1, root, output, down, up);
  assert.equal(step, 1);
  assert.equal(root.style.zoom, '110%');
  assert.equal(output.textContent, '110%');
  assert.equal(down.disabled, false);
  step = update(20, root, output, down, up);
  assert.equal(step, 10);
  assert.equal(root.style.zoom, '200%');
  assert.equal(up.disabled, true);
});
test('section and description panels use a 40:60 layout and obsolete note is removed', () => {
  assert.ok(html.includes('.side{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr)'));
  assert.ok(!html.includes('In „Abschnitte“ löscht X den jeweiligen Abschnitt.'));
  assert.ok(!html.includes('Ein Spurwechsel im Matrixeditor stoppt die Musik automatisch.'));
  assert.ok(html.includes('.page-version{text-align:right}'));
});
test('block movement hint sits below the entire matrix editor', () => {
  assert.ok(html.includes('<div class="matrix-note movement-note">Ziehen zum Verschieben, Kanten zum Kürzen</div>'));
  assert.ok(html.indexOf('<div class="tracks" id="tracks"></div>') < html.indexOf('<div class="matrix-note movement-note">'));
  assert.ok(html.indexOf('<div class="matrix-note movement-note">') < html.indexOf('<div class="addrow">'));
  assert.ok(!html.includes('class="matrix-tooltip movement-tooltip"'));
});
test('add-section action sits close below the matrix hint', () => {
  assert.ok(html.includes('.addrow{display:flex;align-items:center;gap:9px;margin:6px 0 0 114px}'));
});
test('plain guidance and hover tooltips use the standard 12px font size', () => {
  assert.ok(html.includes('.matrix-note{display:block;width:100%;margin:0;padding:0;border:0;border-radius:0;background:transparent;color:var(--muted);font-size:12px;'));
  assert.ok(html.includes('#appTooltip{position:fixed'));
  assert.ok(html.includes('#appTooltip{position:fixed;z-index:9999;max-width:calc(100vw - 16px);padding:7px 10px;border:1px solid var(--line);border-radius:4px;background:var(--panel2);color:var(--ink);font-size:12px;'));
});
test('font size controls sit directly beside their label', () => {
  const label = html.indexOf('<span class="font-label">Schriftgröße</span>');
  const down = html.indexOf('id="fontDown"');
  const output = html.indexOf('id="fontScale"');
  const up = html.indexOf('id="fontUp"');
  assert.ok(label >= 0 && label < down && down < output && output < up);
  assert.ok(!html.includes('.font-controls .font-label{margin-right:auto'));
  assert.ok(html.includes('.font-controls .font-label{color:var(--muted);font-size:12px;font-weight:400}'));
});
test('author footer links to the project repository on GitHub', () => {
  const author = html.indexOf('Matthias Krebs · Version 0.1.0 · 30.10.2026');
  const github = html.indexOf('https://github.com/matzerak/musicflow');
  assert.ok(author >= 0 && github > author);
  assert.match(html.slice(github - 100, github + 160), /href="https:\/\/github\.com\/matzerak\/musicflow"[^>]*>[^<]*GitHub/);
});
test('application branding consistently uses songblox', () => {
  assert.ok(html.includes('<title>songblox</title>'));
  assert.ok(html.includes('<div class="brand">songblox</div>'));
  assert.ok(html.includes("title:'songblox'"));
  assert.doesNotMatch(html, /music blox/i);
});