// rpcd backend for luci-app-nlbw-history.
// The aggregation itself lives in /usr/bin/nlbw-history-query, which chews
// through large history sets far faster than doing the same work here.

'use strict';

const fs = require('fs');

const QUERY = '/usr/bin/nlbw-history-query';
const COLLECT = '/usr/bin/nlbw-history-collect';

function run(cmd) {
	let p = fs.popen(cmd, 'r');
	if (!p)
		return '';
	let out = p.read('all') || '';
	p.close();
	return out;
}

function num(v, def, min, max) {
	let n = +v;
	if (!(n >= min) || !(n <= max))
		return def;
	return int(n);
}

function series(req) {
	let args = req.args || {};
	let hours = num(args.hours, 24, 1, 768);
	let buckets = num(args.buckets, 160, 10, 400);
	// End of the window, 0 meaning now. Lets a past calendar month be asked
	// for without making the window itself any wider.
	let end = num(args.end, 0, 0, 4102444800);
	let mac = lc(replace('' + (args.mac || ''), /[^0-9A-Fa-f:]/g, ''));
	// Protocol names come from nlbwmon's protocol list; keep them to plain
	// characters so they can go on a shell command line safely.
	let proto = replace('' + (args.protocol || ''), /[^0-9A-Za-z._+ -]/g, '');

	if (length(mac) != 17)
		mac = '';

	if (length(proto) > 40)
		proto = substr(proto, 0, 40);

	let out = run(`${QUERY} ${hours} ${buckets} '${mac}' '${proto}' ${end} 2>/dev/null`);
	let data = null;

	try { data = json(out); } catch (e) { data = null; }

	if (type(data) != 'object')
		return { error: 'No samples yet. The first values appear one sampling interval after the service starts.' };

	return data;
}

function status() {
	let out = run(`${COLLECT} --status 2>&1`);
	let info = {};

	for (let line in split(out, '\n')) {
		let i = index(line, ':');
		if (i > 0)
			info[trim(substr(line, 0, i))] = trim(substr(line, i + 1));
	}

	return { status: info, raw: out };
}

return {
	luci_nlbw_history: {
		series: {
			args: { hours: 24, buckets: 160, mac: '', protocol: '', end: 0 },
			call: series
		},
		status: {
			args: {},
			call: status
		}
	}
};
