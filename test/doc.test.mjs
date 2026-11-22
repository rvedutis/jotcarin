// Tests for note to-do helpers: details (body), due dates and editing.   node test/doc.test.mjs
import { docTasks, updateTask, textToInline, setTaskChecked } from '../public/doc.js';

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

console.log(fail ? `${fail} doc test(s) failed, ${pass} passed` : `all ${pass} doc checks passed`);
if (fail) process.exit(1);
