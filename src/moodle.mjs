import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { extractText, getDocumentProxy } from 'unpdf';
import * as z from 'zod';

// Kept in the home folder so the token is never copied or committed with the skill.
const CONFIG = join(homedir(), '.moodle-token.json');
let config;

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('Not logged in: run /login');
  }
}

async function call(wsfunction, params = {}) {
  config ??= loadConfig();
  const response = await fetch(`${config.url}/webservice/rest/server.php`, {
    method: 'POST', // keeps the token out of server URL logs
    body: new URLSearchParams({ wstoken: config.token, wsfunction, moodlewsrestformat: 'json', ...params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = await response.json();
  if (result?.errorcode) {
    const hint = result.errorcode === 'invalidtoken' ? ' - the token expired or was revoked, log in again' : '';
    throw new Error(`Moodle: ${result.errorcode}${hint}`);
  }
  return result;
}

// The browser shows base64 of "signature:::token[:::privatetoken]".
function parseToken(input) {
  const encoded = input.trim().replace(/^.*token=/, '');
  const token = Buffer.from(encoded, 'base64').toString().split(':::')[1];
  assert(/^\w+$/.test(token ?? ''), 'That is not a moodlemobile token');
  return token;
}

const when = (seconds) => (seconds ? new Date(seconds * 1000).toLocaleString('sv') : null);

function plain(html = '') {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' };
  return html
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, name) => {
      if (name[0] !== '#') return entities[name] ?? whole;
      return String.fromCodePoint(Number(name[1] === 'x' ? `0${name.slice(1)}` : name.slice(1)));
    })
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// The web service file address needs the token; the normal one opens in a signed-in browser.
const file = (f) => ({
  name: f.filename,
  size: f.filesize,
  url: f.fileurl?.replace('/webservice/pluginfile.php', '/pluginfile.php'),
});

function matching(courses, query) {
  if (!query) return courses;
  const wanted = query.toLowerCase();
  const found = courses.filter((c) => String(c.id) === wanted || c.fullname.toLowerCase().includes(wanted));
  // An empty result would read as "nothing pending".
  assert(found.length, `No course matches "${query}"`);
  return found;
}

async function userId() {
  return (await call('core_webservice_get_site_info')).userid;
}

async function enrolled(query) {
  return matching(await call('core_enrol_get_users_courses', { userid: await userId() }), query);
}

async function attempt(failed, entry, work) {
  try {
    await work();
  } catch (error) {
    failed.push({ ...entry, error: error.message });
  }
}

function classify(assignment, status, now) {
  const last = status.lastattempt;
  assert(last, 'no submission information returned');
  const submissions = [last.submission, last.teamsubmission];
  const own = (last.teamsubmission ?? last.submission)?.status;
  const state = submissions.some((s) => s?.status === 'submitted')
    ? 'submitted'
    : own === 'draft' || own === 'reopened'
      ? own
      : 'not submitted';
  const due = last.extensionduedate || assignment.duedate;
  return {
    due: when(due),
    overdue: state !== 'submitted' && due > 0 && due < now,
    state,
    graded: Boolean(status.feedback?.grade),
    canSubmit: Boolean(last.canedit),
  };
}

async function assignments(query, onlyPending) {
  const { courses, warnings } = await call('mod_assign_get_assignments');
  const now = Date.now() / 1000;
  const result = { checked: 0, assignments: [], failed: [], noAccess: {} };
  for (const { item } of warnings) result.noAccess[item] = (result.noAccess[item] ?? 0) + 1;
  for (const course of matching(courses, query)) {
    for (const a of course.assignments) {
      if (a.nosubmissions && onlyPending) continue;
      const entry = { id: a.id, course: course.fullname, name: a.name };
      if (a.nosubmissions) {
        result.assignments.push({ ...entry, due: when(a.duedate), state: 'nothing to submit online' });
        continue;
      }
      await attempt(result.failed, entry, async () => {
        const status = await call('mod_assign_get_submission_status', { assignid: a.id });
        const info = classify(a, status, now);
        result.checked++;
        if (!onlyPending || info.state !== 'submitted') result.assignments.push({ ...entry, ...info });
      });
    }
  }
  result.assignments.sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9'));
  return result;
}

async function show(id) {
  const { courses } = await call('mod_assign_get_assignments');
  const course = courses.find((c) => c.assignments.some((a) => String(a.id) === id));
  assert(course, `No assignment with id ${id}`);
  const a = course.assignments.find((x) => String(x.id) === id);
  const status = await call('mod_assign_get_submission_status', { assignid: a.id });
  const submission = status.lastattempt?.teamsubmission ?? status.lastattempt?.submission;
  const filesOf = (plugins = []) => plugins.flatMap((p) => p.fileareas ?? []).flatMap((area) => area.files ?? []).map(file);
  const textOf = (plugins = []) => plain(plugins.flatMap((p) => p.editorfields ?? []).map((f) => f.text).join('\n'));
  return {
    id: a.id,
    course: course.fullname,
    name: a.name,
    url: `${config.url}/mod/assign/view.php?id=${a.cmid}`,
    opens: when(a.allowsubmissionsfromdate),
    cutoff: when(a.cutoffdate),
    ...classify(a, status, Date.now() / 1000),
    instructions: plain([a.intro, a.activity].filter(Boolean).join('\n')),
    attachments: [...(a.introfiles ?? []), ...(a.introattachments ?? [])].map(file),
    submission: {
      modified: when(submission?.timemodified),
      text: textOf(submission?.plugins),
      files: filesOf(submission?.plugins),
    },
    grade: plain(status.feedback?.gradefordisplay) || null,
    feedback: { text: textOf(status.feedback?.plugins), files: filesOf(status.feedback?.plugins) },
  };
}

async function courseList() {
  return (await enrolled()).map((c) => ({ id: c.id, name: c.fullname, progress: c.progress }));
}

async function contents(query) {
  assert(query, 'Usage: contents <course id or name>');
  const result = [];
  for (const course of await enrolled(query)) {
    const sections = await call('core_course_get_contents', { courseid: course.id });
    result.push({
      course: course.fullname,
      sections: sections.map((s) => ({
        name: s.name,
        summary: plain(s.summary),
        modules: s.modules.map((m) => ({
          type: m.modname,
          name: m.name,
          url: m.url,
          dates: m.dates?.map((d) => `${d.label} ${when(d.timestamp)}`),
          files: m.contents?.filter((c) => c.type === 'file').map(file),
        })),
      })),
    });
  }
  return result;
}

async function quizzes(query) {
  const courses = await enrolled(query);
  const result = { quizzes: [], failed: [] };
  const now = Date.now() / 1000;
  for (const quiz of (await call('mod_quiz_get_quizzes_by_courses')).quizzes) {
    const course = courses.find((c) => c.id === quiz.course);
    if (!course) continue;
    const entry = { id: quiz.id, course: course.fullname, name: quiz.name };
    await attempt(result.failed, entry, async () => {
      const { attempts } = await call('mod_quiz_get_user_quiz_attempts', { quizid: quiz.id, status: 'all' });
      result.quizzes.push({
        ...entry,
        url: `${config.url}/mod/quiz/view.php?id=${quiz.coursemodule}`,
        opens: when(quiz.timeopen),
        closes: when(quiz.timeclose),
        closed: quiz.timeclose > 0 && quiz.timeclose < now,
        finishedAttempts: attempts.filter((a) => a.state === 'finished').length,
        unfinishedAttempt: attempts.some((a) => a.state === 'inprogress' || a.state === 'overdue'),
        allowedAttempts: quiz.attempts || 'unlimited',
      });
    });
  }
  return result;
}

async function grades(query) {
  const userid = await userId();
  const result = { courses: [], failed: [] };
  for (const course of await enrolled(query)) {
    await attempt(result.failed, { course: course.fullname }, async () => {
      const { usergrades } = await call('gradereport_user_get_grade_items', { courseid: course.id, userid });
      result.courses.push({
        course: course.fullname,
        items: usergrades[0].gradeitems.map((g) => ({
          name: g.itemname || (g.itemtype === 'course' ? 'Course total' : 'Category total'),
          grade: plain(g.gradeformatted),
          range: plain(g.rangeformatted),
          feedback: plain(g.feedback) || undefined,
        })),
      });
    });
  }
  return result;
}

async function upcoming() {
  const limit = 50; // the most Moodle returns in one call
  const { events } = await call('core_calendar_get_action_events_by_timesort', {
    timesortfrom: Math.floor(Date.now() / 1000),
    limitnum: limit,
  });
  return {
    truncated: events.length === limit,
    events: events.map((e) => ({
      due: when(e.timesort),
      course: e.course?.fullname,
      type: e.modulename,
      name: e.name,
      url: e.url,
    })),
  };
}

async function news(query) {
  const courses = await enrolled(query);
  const result = { posts: [], failed: [] };
  for (const forum of await call('mod_forum_get_forums_by_courses')) {
    const course = courses.find((c) => c.id === forum.course);
    if (!course) continue;
    const entry = { course: course.fullname, forum: forum.name };
    await attempt(result.failed, entry, async () => {
      const { discussions } = await call('mod_forum_get_forum_discussions', { forumid: forum.id, page: 0, perpage: 5 });
      result.posts.push(...discussions.map((d) => ({
        ...entry,
        date: when(d.timemodified),
        subject: d.subject,
        author: d.userfullname,
        replies: d.numreplies,
        message: plain(d.message),
        url: `${config.url}/mod/forum/discuss.php?d=${d.discussion}`,
      })));
    });
  }
  result.posts.sort((a, b) => b.date.localeCompare(a.date));
  result.posts.splice(20);
  return result;
}

// The token is sent with the request, so only this site's file addresses are allowed.
function fileAddress(url, site) {
  const target = new URL(url);
  const base = new URL(site);
  const root = base.pathname.replace(/\/$/, '');
  const prefix = [`${root}/webservice/pluginfile.php/`, `${root}/pluginfile.php/`]
    .find((p) => target.pathname.startsWith(p));
  assert(target.origin === base.origin && prefix, 'That is not a file on your Moodle');
  target.pathname = `${root}/webservice/pluginfile.php/${target.pathname.slice(prefix.length)}`;
  return target;
}

async function openFile({ url, save }) {
  config ??= loadConfig();
  const target = fileAddress(url, config.url);
  const response = await fetch(target, {
    method: 'POST',
    body: new URLSearchParams({ token: config.token }),
    redirect: 'error', // a redirect could carry the token to another site
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = response.headers.get('content-type')?.split(';')[0] ?? '';
  const bytes = Buffer.from(await response.arrayBuffer());
  if (type === 'application/json') {
    const { errorcode } = JSON.parse(bytes);
    if (errorcode) throw new Error(`Moodle: ${errorcode}`);
  }
  const reply = (value) => ({ type: 'text', text: value });
  const name = basename(decodeURIComponent(target.pathname));
  if (save) {
    // A new folder each time, so a downloaded file never sits next to anything else.
    const path = join(mkdtempSync(join(tmpdir(), 'moodle-')), name);
    writeFileSync(path, bytes);
    return reply(path);
  }
  if (/^image\/(png|jpeg|gif|webp)$/.test(type)) return { type: 'image', data: bytes.toString('base64'), mimeType: type };
  if (type === 'application/pdf') {
    const { text: pages } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: true });
    return reply(pages.trim() || 'This PDF has no readable text. Call again with save to look at it.');
  }
  if (type.startsWith('text/') || type === 'application/json') return reply(bytes.toString());
  throw new Error(`Cannot read ${type || 'this file type'} directly. Call again with save.`);
}

// Acceso Único (CAS), the only sign-in this Moodle offers.
const CAS = 'https://edea.juntadeandalucia.es';
const SITE = 'https://educacionadistancia.juntadeandalucia.es/centros/sevilla';

async function casRequest(jar, url, body) {
  const { host } = new URL(url);
  const cookies = jar.get(host) ?? new Map();
  jar.set(host, cookies);
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    body,
    redirect: 'manual', // never lets the password body be resent somewhere else
    headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    signal: AbortSignal.timeout(30_000),
  });
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const at = pair.indexOf('=');
    cookies.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return response;
}

async function casFollow(jar, url, body) {
  let response = await casRequest(jar, url, body);
  for (let hop = 0; hop < 10; hop++) {
    const next = response.headers.get('location');
    if (!next || next.startsWith('moodlemobile:')) return { url, response, next };
    url = new URL(next, url).href;
    response = await casRequest(jar, url);
  }
  throw new Error('Too many redirects');
}

async function login() {
  const { MOODLE_USER: user, MOODLE_PASSWORD: password } = process.env;
  assert(user && password, 'Set MOODLE_USER and MOODLE_PASSWORD');
  const jar = new Map();
  const start = await casFollow(jar, `${SITE}/login/index.php?authCAS=CAS`);
  const execution = (await start.response.text()).match(/name="execution"\s+value="([^"]+)"/)?.[1];
  assert(start.url.startsWith(`${CAS}/cas/login`) && execution, 'Sign-in form not found');
  const signedIn = await casFollow(jar, start.url, new URLSearchParams({
    username: user, password, execution, _eventId: 'submit', geolocation: '',
  }));
  assert(signedIn.url.startsWith(SITE), 'Not signed in: stayed outside Moodle');
  const launch = await casFollow(jar, `${SITE}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=12345&urlscheme=moodlemobile`);
  const address = launch.next ?? (await launch.response.text()).match(/moodlemobile:\/\/token=[\w+/=]+/)?.[0];
  assert(address, 'No token received');
  config = { url: SITE, token: parseToken(address) };
  const { fullname } = await call('core_webservice_get_site_info');
  writeFileSync(CONFIG, JSON.stringify(config), { mode: 0o600 });
  return `Logged in as ${fullname}. Token saved to ${CONFIG}`;
}

function selftest() {
  const assignment = { duedate: 100 };
  const status = (submission, extra) => ({ lastattempt: { submission, ...extra } });
  const check = (...args) => classify(assignment, status(...args), 200);
  assert.equal(check({ status: 'submitted' }).overdue, false);
  assert.equal(check({ status: 'new' }, { teamsubmission: { status: 'submitted' } }).state, 'submitted');
  assert.equal(check(undefined).state, 'not submitted');
  assert.equal(check({ status: 'draft' }).overdue, true);
  assert.equal(check({ status: 'new' }, { extensionduedate: 300 }).overdue, false);
  assert.equal(classify({ duedate: 0 }, status({ status: 'reopened' }), 200).due, null);
  assert.throws(() => classify(assignment, {}, 200));
  const encoded = Buffer.from('sig:::abc123:::private').toString('base64');
  assert.equal(parseToken(encoded), 'abc123');
  assert.equal(parseToken(`moodlemobile://token=${encoded}\n`), 'abc123');
  assert.throws(() => parseToken('nonsense'));
  assert.equal(plain('<p>a &amp; <a href="x">b</a></p><p>&#241;&#xf1;</p>'), 'a & b (x)\nññ');
  assert.equal(plain('0&ndash;10'), '0–10');
  assert.equal(matching([{ id: 1, fullname: 'Redes' }], 'red').length, 1);
  assert.throws(() => matching([], 'red'));
  const site = 'https://school.example/moodle';
  const allowed = 'https://school.example/moodle/webservice/pluginfile.php/1/a.pdf';
  assert.equal(fileAddress('https://school.example/moodle/pluginfile.php/1/a.pdf', site).href, allowed);
  assert.equal(fileAddress(allowed, site).href, allowed);
  assert.throws(() => fileAddress('https://evil.example/moodle/pluginfile.php/1/a.pdf', site));
  assert.throws(() => fileAddress(`${site}/pluginfile.php/../login/index.php`, site));
  return 'ok';
}

function createServer() {
  const server = new McpServer({ name: 'moodle', version: '1.0.0' });
  const tool = (name, description, shape, work) =>
    server.registerTool(
      name,
      { description, inputSchema: z.object(shape), annotations: { readOnlyHint: true } },
      async (args) => {
        config = undefined; // pick up a new login without restarting the server
        return { content: [{ type: 'text', text: JSON.stringify(await work(args), null, 1) }] };
      },
    );
  const course = z.string().optional().describe('Course id or part of its name');

  tool('pending', 'Assignments not submitted, overdue ones included', { course }, (a) => assignments(a.course, true));
  tool('list', 'Every assignment with its state', { course }, (a) => assignments(a.course, false));
  tool('show', 'One assignment: instructions, files, dates, submission, grade, feedback',
    { id: z.number().int().describe('Assignment id from pending or list') }, (a) => show(String(a.id)));
  tool('courses', 'Enrolled courses', {}, courseList);
  tool('contents', 'Sections, activities and files of a course', { course: course.unwrap() }, (a) => contents(a.course));
  tool('quizzes', 'Quizzes with open and close dates and attempts used', { course }, (a) => quizzes(a.course));
  tool('grades', 'Grade items and totals', { course }, (a) => grades(a.course));
  tool('upcoming', 'Calendar deadlines from now on', {}, upcoming);
  tool('news', 'The 20 latest forum discussions', { course }, (a) => news(a.course));
  server.registerTool(
    'login',
    { description: 'Sign in through Acceso Único with MOODLE_USER/MOODLE_PASSWORD and save a fresh token', inputSchema: z.object({}) },
    async () => {
      config = undefined;
      return { content: [{ type: 'text', text: await login() }] };
    },
  );
  server.registerTool(
    'file',
    {
      description: 'Read a Moodle file: text of PDFs and text files, or an image. Kept in memory unless save is set',
      inputSchema: z.object({
        url: z.string().describe('File url from show or contents'),
        save: z.boolean().optional().describe('Save to a new temporary folder and return the path instead'),
      }),
    },
    async (args) => {
      config = undefined;
      return { content: [await openFile(args)] };
    },
  );
  return server;
}

const [command] = process.argv.slice(2);
try {
  if (command === 'login') console.log(await login());
  else if (command === 'selftest') console.log(selftest());
  else {
    assert(!command, 'Commands: login, selftest, or none to start the MCP server');
    serveStdio(createServer);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
