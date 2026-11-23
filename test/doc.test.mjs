// Tests for note to-do helpers: details (body), due dates and editing.   node test/doc.test.mjs
import { docTasks, updateTask, textToInline, setTaskChecked, markUndatedTasks } from '../public/doc.js';

let fail = 0;
let pass = 0;
const check = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL: ${name}`, extra === undefined ? '' : JSON.stringify(extra)); } };
const p = (...content) => ({ type: 'paragraph', content });
const t = (text) => ({ type: 'text', text });
const item = (attrs, ...content) => ({ type: 'taskItem', attrs: { checked: false, ...attrs }, content });
const doc = {
  type: 'doc',
  content: [
    p(t('Intro')),
    { type: 'taskList', content: [
      item({}, p(t('Call Dana')), p(t('About the budget')), p(t('and the offsite')), { type: 'taskList', content: [item({}, p(t('Sub task')))] }),
      item({ due: '2026-12-01' }, p(t('Send deck '), { type: 'date', attrs: { date: '2026-11-20' } })),
      item({}, p({ type: 'text', text: 'Bold', marks: [{ type: 'bold' }] }), { type: 'codeBlock', content: [t('x = 1')] }),
    ] },
  ],
};

const tasks = docTasks(doc);
check('four to-dos found (incl. nested)', tasks.length === 4, tasks.map((x) => x.text));
check('title is the first line', tasks[0].text === 'Call Dana');
check('details are the lines under it, not sub-tasks', tasks[0].body === 'About the budget\nand the offsite', tasks[0].body);
check('plain details are editable', tasks[0].bodyEditable === true);
check('nested sub-task is its own to-do', tasks[1].text === 'Sub task' && tasks[1].body === '');
check('due date read from the to-do', tasks[2].due === '2026-12-01' && tasks[0].due === null);
check('date tags read as labels in the title', tasks[2].text === 'Send deck Fri, Nov 20, 2026', tasks[2].text);
check('rich details (code block) are not editable here', tasks[3].bodyEditable === false);

let d = updateTask(doc, 0, { title: 'Call Dana Fri, Nov 27, 2026', body: 'Line one\n\nLine three', due: '2026-12-05' });
let u = docTasks(d)[0];
check('title updated, date label became a tag', u.text === 'Call Dana Fri, Nov 27, 2026' && u.nodes.some((n) => n.type === 'date' && n.attrs.date === '2026-11-27'), u.nodes);
check('details replaced (blank lines kept)', u.body === 'Line one\n\nLine three', u.body);
check('due set', u.due === '2026-12-05');
check('sub-task kept under the to-do', docTasks(d)[1].text === 'Sub task');
check('original document untouched', docTasks(doc)[0].text === 'Call Dana');

d = updateTask(d, 0, { body: '', due: null });
u = docTasks(d)[0];
check('details cleared', u.body === '' && docTasks(d).length === 4);
check('due cleared', u.due === null);
check('rich details refuse a plain-text overwrite', updateTask(doc, 3, { body: 'x' }) === null);
check('title of a to-do with rich details can still change', docTasks(updateTask(doc, 3, { title: 'Plain' }))[3].text === 'Plain');
check('missing to-do → null', updateTask(doc, 9, { title: 'x' }) === null);
check('checking keeps the due date', docTasks(setTaskChecked(doc, 2, true))[2].due === '2026-12-01');
check('textToInline: no dates → one text node', JSON.stringify(textToInline('hello')) === JSON.stringify([t('hello')]));
check('textToInline: empty → nothing', textToInline('').length === 0);

// created / edited stamps
const stamped = { type: 'doc', content: [{ type: 'taskList', content: [item({ created: 1700000000000, edited: 1700000500000 }, p(t('Dated'))), item({}, p(t('Old'))), item({ created: 0 }, p(t('Unknown')))] }] };
const st = docTasks(stamped);
check('created/edited read from the to-do', st[0].created === 1700000000000 && st[0].edited === 1700000500000);
check('no date recorded → null', st[1].created === null && st[2].created === null);
const marked = markUndatedTasks(stamped);
check('old to-dos marked unknown (0), dated ones untouched', marked.count === 1 && marked.doc.content[0].content[1].attrs.created === 0 && marked.doc.content[0].content[0].attrs.created === 1700000000000);
check('marking again changes nothing', markUndatedTasks(marked.doc).count === 0);
const before = Date.now();
const ed = docTasks(updateTask(stamped, 0, { title: 'Dated!' }))[0];
check('editing in the panel updates edited, keeps created', ed.edited >= before && ed.created === 1700000000000);
// board column (stage)
const sd = { type: 'doc', content: [{ type: 'taskList', content: [item({}, p(t('A'))), item({ stage: 'doing' }, p(t('B'))), item({ checked: true, stage: 'doing' }, p(t('C')))] }] };
const sx = docTasks(sd);
check('column read: default To do, Doing kept', sx[0].stage === 'todo' && sx[1].stage === 'doing');
let sdoc = updateTask(sd, 0, { stage: 'doing' });
check('moved to Doing', docTasks(sdoc)[0].stage === 'doing' && !docTasks(sdoc)[0].done);
sdoc = updateTask(sdoc, 0, { stage: 'done' });
check('moved to Done = checked, column remembered', docTasks(sdoc)[0].done && docTasks(sdoc)[0].stage === 'doing');
sdoc = updateTask(sdoc, 0, { stage: 'todo' });
check('back to To do: unchecked', !docTasks(sdoc)[0].done && docTasks(sdoc)[0].stage === 'todo');
check('unchecking a Done task returns it to its column', docTasks(setTaskChecked(sd, 2, false))[2].stage === 'doing');
console.log(fail ? `${fail} doc test(s) failed, ${pass} passed` : `all ${pass} doc checks passed`);
if (fail) process.exit(1);
