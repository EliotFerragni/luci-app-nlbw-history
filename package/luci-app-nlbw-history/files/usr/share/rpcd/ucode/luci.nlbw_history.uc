// rpcd backend for luci-app-nlbw-history.
// The aggregation itself lives in /usr/bin/nlbw-history-query, which chews
// through large history sets far faster than doing the same work here.

'use strict';

const fs = require('fs');

const QUERY = '/usr/bin/nlbw-history-query';
const COLLECT = '/usr/bin/nlbw-history-collect';
const LIVE = '/usr/bin/nlbw-history-live';

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

	// Keys the chart should leave out, comma separated: MACs or protocol
	// names, so the same character set as above minus the separator itself.
	let hide = replace('' + (args.hide || ''), /[^0-9A-Za-z._:,+ -]/g, '');

	// Cap the list rather than drop it: charting a series the user hid is more
	// surprising than leaving the tail of an absurdly long list hidden.
	if (length(hide) > 512) {
		hide = substr(hide, 0, 512);
		let cut = rindex(hide, ',');
		hide = (cut > 0) ? substr(hide, 0, cut) : '';
	}

	let out = run(`${QUERY} ${hours} ${buckets} '${mac}' '${proto}' ${end} '${hide}' 2>/dev/null`);
	let data = null;

	try { data = json(out); } catch (e) { data = null; }

	if (type(data) != 'object')
		return { error: 'No samples yet. The first values appear one sampling interval after the service starts.' };

	return data;
}

// Rewrites stored history, so it is only ever reached through the settings
// page's confirm step. apply is built here rather than passed through, so
// nothing from the request reaches the command line.
function scrub(req) {
	let apply = (req.args && req.args.apply) ? ' --apply' : '';
	return { output: run(`${COLLECT} --scrub${apply} 2>&1`) };
}

// The poll doubles as the signal that keeps the on demand sampler alive.
// Only a MAC goes through, and only after the same scrubbing the series call
// gives its own, because it reaches a shell command line.
function live(req) {
	let args = req.args || {};
	let mac = lc(replace('' + (args.device || ''), /[^0-9A-Fa-f:]/g, ''));

	if (length(mac) != 17)
		mac = '';

	// Protocol names can carry a space, a dot or a colon, so the class is wider
	// than the MAC's. It still drops every quote, which is what keeps it safe
	// on the command line. Deliberately no slash in here: escaping one inside
	// a bracket expression is where ucode's lexer has bitten before, so the
	// unnamed-port labels use a colon instead.
	let proto = replace('' + (args.protocol || ''), /[^0-9A-Za-z._+: -]/g, '');

	if (length(proto) > 40)
		proto = substr(proto, 0, 40);

	let out = run(`${LIVE} '${mac}' '${proto}' 2>/dev/null`);
	let data = null;

	try { data = json(out); } catch (e) { data = null; }

	if (type(data) != 'object')
		return { error: 'The live sampler returned nothing. Check nlbw-history-live --status.' };

	return data;
}

// key: value lines into an object. Split on the FIRST colon, so a value that
// contains colons of its own, such as a list of IPv6 prefixes, survives.
function kv(out) {
	let info = {};

	for (let line in split(out, '\n')) {
		let i = index(line, ':');
		if (i > 0)
			info[trim(substr(line, 0, i))] = trim(substr(line, i + 1));
	}

	return info;
}

// Both samplers, kept apart rather than merged: they each have a 'sampler'
// key and they mean different processes.
function status() {
	let out = run(`${COLLECT} --status 2>&1`);
	let live = run(`${LIVE} --status 2>&1`);

	// Both raw dumps as well, for the Full diagnostics button: a parsed map
	// loses the lines that carry no colon, which is where the hints live.
	return { status: kv(out), live: kv(live), raw: out, live_raw: live };
}

return {
	luci_nlbw_history: {
		series: {
			args: { hours: 24, buckets: 160, mac: '', protocol: '', end: 0, hide: '' },
			call: series
		},
		status: {
			args: {},
			call: status
		},
		scrub: {
			args: { apply: false },
			call: scrub
		},
		live: {
			args: { device: '', protocol: '' },
			call: live
		}
	}
};
