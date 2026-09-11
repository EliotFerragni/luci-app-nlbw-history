'use strict';
'require view';
'require rpc';
'require poll';
'require uci';

const callSeries = rpc.declare({
	object: 'luci_nlbw_history',
	method: 'series',
	params: [ 'hours', 'buckets', 'mac', 'protocol', 'end', 'hide' ]
});

const callStatus = rpc.declare({
	object: 'luci_nlbw_history',
	method: 'status'
});

const PALETTE = [ '#3d6fb4', '#d98032', '#4e9e6a', '#c2504f', '#7a6bab',
                  '#3aa3a8', '#b4699b', '#8a7f6d' ];
const OTHER_COLOR = '#9aa3ac';

// range is either { hours: n } ending now, or a calendar month { year, month }.
let state = { mac: '', protocol: '', range: { hours: 24 }, data: null, status: null };

// 'si' counts in thousands and prints MB, 'iec' counts in 1024s and prints MiB.
let UNITS = 'si';

// Clock and date order, from the router's config. 'auto' leaves both to the
// browser's locale, which is what a fresh install does.
let FORMATS = { time: 'auto', date: 'auto' };

function loadFormats() {
	let t, d;
	try {
		t = uci.get('nlbw-history', 'main', 'time_format');
		d = uci.get('nlbw-history', 'main', 'date_format');
	}
	catch (e) {}
	FORMATS = {
		time: (t === '12' || t === '24') ? t : 'auto',
		date: (d === 'dmy' || d === 'mdy') ? d : 'auto'
	};
}

// hourCycle rather than hour12:false, which renders midnight as 24:00 in a
// few locales.
function clockOpts(opts) {
	if (FORMATS.time === '12') return Object.assign({ hour12: true }, opts);
	if (FORMATS.time === '24') return Object.assign({ hourCycle: 'h23' }, opts);
	return opts;
}

function loadUnits() {
	try { UNITS = window.localStorage.getItem('nlbw-history.units') || 'si'; }
	catch (e) { UNITS = 'si'; }
	if (UNITS !== 'si' && UNITS !== 'iec') UNITS = 'si';
}

function saveUnits(v) {
	UNITS = v;
	try { window.localStorage.setItem('nlbw-history.units', v); } catch (e) {}
}

// Series taken out of the stack so the rest can use the full height of the
// chart, because one device pulling a hundred times what the others do
// flattens them all into the baseline. Kept per stacked dimension: MACs when
// devices are stacked, protocol names when protocols are. It is a display
// choice, so it lives in the browser and not in the router's config.
let hidden = { devices: {}, protocols: {} };

function loadHidden() {
	hidden = { devices: {}, protocols: {} };
	let raw = null;
	try { raw = window.localStorage.getItem('nlbw-history.hidden'); } catch (e) { return; }
	if (!raw) return;
	try {
		const o = JSON.parse(raw) || {};
		[ 'devices', 'protocols' ].forEach(function(dim) {
			for (let k of o[dim] || [])
				if (typeof k === 'string' && k !== '') hidden[dim][k] = true;
		});
	} catch (e) {}
}

function saveHidden() {
	try {
		window.localStorage.setItem('nlbw-history.hidden', JSON.stringify({
			devices: Object.keys(hidden.devices),
			protocols: Object.keys(hidden.protocols)
		}));
	} catch (e) {}
}

// Which dimension the chart stacks, and so which hidden set applies. The
// backend decides the same way: protocols when a single device is selected,
// devices otherwise.
function dimOf(data) {
	return (data && data.mode === 'protocols') ? 'protocols' : 'devices';
}

function hideParam(mac, protocol) {
	return Object.keys(hidden[(mac && !protocol) ? 'protocols' : 'devices']).join(',');
}

// Resolved per request rather than when the period is picked, so the current
// month keeps following the clock as the page polls.
function rangeWindow(r) {
	if (!r.year)
		return { hours: r.hours, end: 0 };
	const start = Math.floor(new Date(r.year, r.month - 1, 1).getTime() / 1000);
	const next = Math.floor(new Date(r.year, r.month, 1).getTime() / 1000);
	// The backend takes a whole number of hours before the end of the window,
	// so the end is rounded up to the hour to keep the start on the 1st.
	const end = Math.min(next, Math.ceil(Date.now() / 3600000) * 3600);
	return { hours: Math.max(1, Math.round((end - start) / 3600)), end: end };
}

// The months that retention can still hold anything for, newest first.
function monthOptions(days) {
	const now = new Date();
	const out = [];
	for (let i = 0; i < Math.min(14, Math.ceil(days / 28) + 1); i++) {
		const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
		if (i > 0 && (now - d) / 86400000 > days + 31)
			break;
		out.push({ value: 'm' + d.getFullYear() + '-' + (d.getMonth() + 1),
		           label: d.toLocaleDateString([], { month: 'long', year: 'numeric' }) });
	}
	return out;
}

function esc(s) {
	return String(s).replace(/[&<>"']/g, function(c) {
		return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
	});
}

function fmtBytes(n) {
	const iec = (UNITS === 'iec');
	const base = iec ? 1024 : 1000;
	const u = iec ? [ 'B', 'KiB', 'MiB', 'GiB', 'TiB' ] : [ 'B', 'kB', 'MB', 'GB', 'TB' ];
	let i = 0;
	n = +n || 0;
	while (n >= base && i < u.length - 1) { n /= base; i++; }
	return (i === 0 || n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}

function fmtRate(bps) {
	if (!isFinite(bps) || bps <= 0) return '0';
	if (bps < 1000) return bps.toFixed(0) + ' bit/s';
	if (bps < 1e6) return (bps / 1e3).toFixed(bps < 1e5 ? 1 : 0) + ' kbit/s';
	if (bps < 1e9) return (bps / 1e6).toFixed(bps < 1e8 ? 1 : 0) + ' Mbit/s';
	return (bps / 1e9).toFixed(2) + ' Gbit/s';
}

function fmtDayMonth(d) {
	const dd = ('0' + d.getDate()).slice(-2);
	const mm = ('0' + (d.getMonth() + 1)).slice(-2);
	if (FORMATS.date === 'dmy') return dd + '/' + mm;
	if (FORMATS.date === 'mdy') return mm + '/' + dd;
	return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

function fmtTime(ts, span) {
	const d = new Date(ts * 1000);
	if (span <= 48 * 3600)
		return d.toLocaleTimeString([], clockOpts({ hour: '2-digit', minute: '2-digit' }));
	return fmtDayMonth(d) + ' ' +
	       d.toLocaleTimeString([], clockOpts({ hour: '2-digit' }));
}

function niceMax(v) {
	if (!(v > 0)) return 1000;
	if (UNITS === 'iec') {
		// round up to 1, 2, 4 ... times a power of 1024, so the quarter marks
		// stay whole numbers
		let u = 1;
		while (v / u >= 1024) u *= 1024;
		let f = 1;
		while (f < v / u) f *= 2;
		return f * u;
	}
	let e = 1;
	while (v / e >= 10) e *= 10;
	const f = v / e;
	return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e;
}

function fmtSpan(sec) {
	if (sec < 60) return Math.round(sec) + ' s';
	if (sec < 3600) return Math.round(sec / 60) + ' min';
	if (sec % 3600 === 0 && sec <= 86400) return (sec / 3600) + ' h';
	return (sec / 3600).toFixed(1) + ' h';
}

// Built as an SVG string on purpose: LuCI's E() uses createElement, which
// cannot produce namespaced SVG nodes, so appending E('svg') renders nothing.
function chartSVG(data, keys, labels, colors, field, title) {
	const W = 1000, H = 270, L = 74, R = 14, T = 30, B = 30;
	const pw = W - L - R, ph = H - T - B;
	const nb = data.buckets, step = data.step || 1;
	const span = data.to - data.from;

	let peak = 0;
	for (let b = 0; b < nb; b++) {
		let sum = 0;
		for (let k of keys) sum += (data.series[k] && data.series[k][field][b]) || 0;
		if (sum > peak) peak = sum;
	}
	const max = niceMax(peak);

	let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block">';
	s += '<text x="0" y="13" font-size="12" font-weight="600" fill="currentColor" fill-opacity="0.75">' + esc(title) + '</text>';
	s += '<text x="' + (W - R) + '" y="13" text-anchor="end" font-size="11" fill="currentColor" ' +
	     'fill-opacity="0.6">' + esc(_('per') + ' ' + fmtSpan(step)) + '</text>';

	for (let i = 0; i <= 4; i++) {
		const y = T + ph - ph * i / 4;
		s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) +
		     '" stroke="currentColor" stroke-opacity="0.12"/>';
		s += '<text x="' + (L - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" font-size="11" ' +
		     'fill="currentColor" fill-opacity="0.7">' + esc(fmtBytes(max * i / 4)) + '</text>';
	}

	const bw = pw / nb;
	for (let b = 0; b < nb; b++) {
		let acc = 0;
		for (let i = 0; i < keys.length; i++) {
			const arr = data.series[keys[i]];
			const v = (arr && arr[field][b]) || 0;
			if (v <= 0) continue;
			const h = ph * v / max;
			const x = L + b * bw;
			s += '<rect x="' + x.toFixed(2) + '" y="' + (T + ph - acc - h).toFixed(2) +
			     '" width="' + Math.max(bw - 0.6, 0.6).toFixed(2) + '" height="' + h.toFixed(2) +
			     '" fill="' + colors[i] + '"><title>' +
			     esc(fmtTime(data.from + b * step, span) + '  ' + labels[i] + '  ' + fmtBytes(v) +
			         '  (' + fmtRate(v * 8 / step) + ')') + '</title></rect>';
			acc += h;
		}
	}

	for (let i = 0; i <= 6; i++) {
		const x = L + pw * i / 6;
		const anchor = i === 0 ? 'start' : (i === 6 ? 'end' : 'middle');
		s += '<text x="' + x.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="' + anchor +
		     '" font-size="11" fill="currentColor" fill-opacity="0.7">' +
		     esc(fmtTime(data.from + span * i / 6, span)) + '</text>';
	}

	s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + (T + ph) + '" y2="' + (T + ph) +
	     '" stroke="currentColor" stroke-opacity="0.3"/></svg>';
	return s;
}

function keyLabel(data, key) {
	if (key === 'other') return _('Other');
	if (data.mode === 'protocols') return key;
	for (let d of data.devices || [])
		if (d.mac === key) return d.name || d.mac;
	return key;
}

function renderCharts(node, data, onToggle) {
	const dim = dimOf(data);
	// The backend already leaves hidden keys out of the series, and drops them
	// before picking the top N so a further one can come up out of "other".
	// Filtering again here is what makes a click rescale the chart at once,
	// without waiting for the refreshed series to come back.
	const keys = Object.keys(data.series || {}).filter(function(k) { return !hidden[dim][k]; });
	if (!keys.length) {
		node.innerHTML = '';
		node.appendChild(E('p', {}, Object.keys(hidden[dim]).length
			? _('Everything in this period is hidden. Tick a row in the table below to bring it back.')
			: _('No traffic recorded in this period yet.')));
		return;
	}

	const order = (data.mode === 'protocols' ? data.protocols : data.devices) || [];
	const rank = {};
	order.forEach(function(o, i) { rank[o.mac || o.name] = i; });
	keys.sort(function(a, b) {
		if (a === 'other') return 1;
		if (b === 'other') return -1;
		return (rank[a] === undefined ? 1e9 : rank[a]) - (rank[b] === undefined ? 1e9 : rank[b]);
	});

	const colors = keys.map(function(k, i) { return k === 'other' ? OTHER_COLOR : PALETTE[i % PALETTE.length]; });
	const labels = keys.map(function(k) { return keyLabel(data, k); });
	const by = data.mode === 'protocols' ? _('by protocol') : _('by device');

	node.innerHTML = chartSVG(data, keys, labels, colors, 'rx', _('Download') + ' ' + by) +
	                 chartSVG(data, keys, labels, colors, 'tx', _('Upload') + ' ' + by);

	const legend = E('div', { style: 'display:flex;flex-wrap:wrap;gap:6px 18px;padding:8px 0 2px;font-size:13px' });
	keys.forEach(function(k, i) {
		// "other" is an aggregate with no stable key behind it, so it is the
		// one band that cannot be hidden on its own.
		const clickable = (k !== 'other');
		const item = E('span', {
			style: 'display:flex;align-items:center;gap:6px' + (clickable ? ';cursor:pointer' : ''),
			title: clickable ? _('Hide from the chart') : ''
		}, [
			E('i', { style: 'width:11px;height:11px;border-radius:2px;background:' + colors[i] }),
			labels[i]
		]);
		if (clickable)
			item.addEventListener('click', function() { onToggle(k); });
		legend.appendChild(item);
	});
	node.appendChild(legend);
}

function renderTable(node, data, onPick, onToggle) {
	node.innerHTML = '';

	const dim = dimOf(data);
	const proto = data.mode === 'protocols';
	const rows = (proto ? data.protocols : data.devices) || [];
	if (!rows.length)
		return;

	const top = rows[0].rx + rows[0].tx || 1;
	const out = [ E('tr', { 'class': 'tr table-titles' }, [
		E('th', { 'class': 'th', style: 'width:1px;white-space:nowrap' }, _('Chart')),
		E('th', { 'class': 'th' }, proto ? _('Protocol') : _('Device')),
		E('th', { 'class': 'th', style: 'text-align:right' }, _('Download')),
		E('th', { 'class': 'th', style: 'text-align:right' }, _('Upload')),
		E('th', { 'class': 'th', style: 'text-align:right' }, _('Total')),
		E('th', { 'class': 'th', style: 'width:20%' }, _('Share'))
	]) ];

	let i = 0;
	for (let r of rows) {
		const key = proto ? r.name : r.mac;
		const total = r.rx + r.tx;
		const off = !!hidden[dim][key];
		const color = r.charted ? PALETTE[(i++) % PALETTE.length] : OTHER_COLOR;
		// Set as a property rather than an attribute: LuCI's E() would put a
		// literal checked="false" on the node, which still checks the box.
		const box = E('input', {
			type: 'checkbox',
			title: off ? _('Show this in the chart') : _('Hide this from the chart'),
			change: function() { onToggle(key); }
		});
		box.checked = !off;
		out.push(E('tr', Object.assign({ 'class': 'tr' }, off ? { style: 'opacity:0.55' } : {}), [
			E('td', { 'class': 'td', style: 'width:1px' }, box),
			E('td', { 'class': 'td' }, [
				E('a', {
					href: '#',
					click: function(ev) { ev.preventDefault(); onPick(key); }
				}, proto ? r.name : (r.name || r.mac)),
				(!proto && r.name && r.name !== r.mac) ? E('span', { style: 'opacity:0.6' }, ' ' + r.mac) : ''
			]),
			E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(r.rx)),
			E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(r.tx)),
			E('td', { 'class': 'td', style: 'text-align:right' }, fmtBytes(total)),
			E('td', { 'class': 'td' }, E('div', {
				style: 'height:7px;border-radius:4px;background:' + color +
				       ';width:' + (100 * total / top).toFixed(1) + '%'
			}))
		]));
	}

	node.appendChild(E('div', { 'class': 'table' }, out));
}

return view.extend({
	load: function() {
		// Loaded before the first request so a series hidden in an earlier
		// visit is already left out of the very first chart.
		loadHidden();
		return Promise.all([
			callStatus().catch(function() { return null; }),
			callSeries(24, 160, '', '', 0, hideParam('', ''))
				.catch(function(e) { return { error: '' + e }; }),
			// Display formats live in the router's config; the graphs fall back
			// to the browser's locale if it cannot be read.
			uci.load('nlbw-history').catch(function() {})
		]);
	},

	render: function(res) {
		state.status = res[0];
		state.data = res[1];
		loadUnits();
		loadFormats();

		const deviceSel = E('select', { 'class': 'cbi-input-select', style: 'min-width:240px' });
		const protoSel = E('select', { 'class': 'cbi-input-select', style: 'min-width:140px' });
		const rangeSel = E('select', { 'class': 'cbi-input-select' });
		const unitsSel = E('select', { 'class': 'cbi-input-select' }, [
			E('option', Object.assign({ value: 'si' }, UNITS === 'si' ? { selected: 'selected' } : {}),
				_('kB, MB, GB (1000 per step)')),
			E('option', Object.assign({ value: 'iec' }, UNITS === 'iec' ? { selected: 'selected' } : {}),
				_('KiB, MiB, GiB (1024 per step)'))
		]);

		[ [ 1, _('Last hour') ], [ 6, _('Last 6 hours') ], [ 24, _('Last 24 hours') ],
		  [ 72, _('Last 3 days') ], [ 168, _('Last 7 days') ], [ 720, _('Last 30 days') ] ]
			.forEach(function(o) {
				rangeSel.appendChild(E('option', Object.assign({ value: 'h' + o[0] },
					o[0] === state.range.hours ? { selected: 'selected' } : {}), o[1]));
			});

		// A whole month is at most 32 days of samples to read, so browsing back
		// through a long retention costs no more than the 30 day view does.
		const months = monthOptions(parseInt(((state.status && state.status.status) || {})['retention'], 10) || 30);
		if (months.length)
			rangeSel.appendChild(E('optgroup', { label: _('Calendar month') },
				months.map(function(m) { return E('option', { value: m.value }, m.label); })));

		// Label and control travel together: themes with wide inputs wrap this
		// row, and a bare label would otherwise be left behind on its own line.
		function field(label, control) {
			return E('span', { style: 'display:flex;align-items:center;gap:6px;margin-right:16px' },
				[ E('label', {}, label), control ]);
		}

		const chartNode = E('div', {});
		const tableNode = E('div', {});
		const hiddenNode = E('div', { style: 'font-size:13px;margin-top:8px' });
		const statusNode = E('div', { style: 'font-size:13px;opacity:0.75;margin-top:8px' });
		const errorNode = E('div', { 'class': 'alert-message warning', style: 'display:none' });

		function fillSelect(sel, current, allLabel, items, valueOf, labelOf) {
			sel.innerHTML = '';
			sel.appendChild(E('option', { value: '' }, allLabel));
			let found = false;
			for (let it of items || []) {
				const v = valueOf(it);
				if (v === current) found = true;
				sel.appendChild(E('option', { value: v }, labelOf(it)));
			}
			// Keep a filter that has no traffic in this window selectable.
			if (current && !found)
				sel.appendChild(E('option', { value: current }, current));
			sel.value = current;
		}

		// Repaint at once from the data already loaded, so the chart rescales
		// on the click, then refetch: the backend picks the top N among what
		// is left, which can bring a further series up out of "other".
		function toggleHidden(key) {
			const dim = dimOf(state.data);
			if (hidden[dim][key]) delete hidden[dim][key];
			else hidden[dim][key] = true;
			saveHidden();
			paint();
			refresh();
		}

		function renderHidden(data) {
			const dim = dimOf(data);
			const keys = Object.keys(hidden[dim]);
			hiddenNode.innerHTML = '';
			if (!keys.length)
				return;
			hiddenNode.appendChild(E('span', { style: 'opacity:0.75' },
				(dim === 'protocols' ? _('Hidden protocols') : _('Hidden devices')) + ': ' +
				keys.map(function(k) { return keyLabel(data, k); }).join(', ') + ' \u2014 '));
			hiddenNode.appendChild(E('a', {
				href: '#',
				click: function(ev) {
					ev.preventDefault();
					hidden[dim] = {};
					saveHidden();
					paint();
					refresh();
				}
			}, _('show all')));
		}

		function paint() {
			const data = state.data;
			if (!data || data.error) {
				errorNode.style.display = '';
				errorNode.textContent = (data && data.error) || _('No data returned.');
				chartNode.innerHTML = '';
				tableNode.innerHTML = '';
				hiddenNode.innerHTML = '';
				return;
			}
			errorNode.style.display = 'none';

			fillSelect(deviceSel, state.mac, _('All devices'), data.devices,
				function(d) { return d.mac; },
				function(d) { return (d.name && d.name !== d.mac) ? d.name + ' (' + d.mac + ')' : d.mac; });
			fillSelect(protoSel, state.protocol, _('All protocols'), data.protocols,
				function(p) { return p.name; },
				function(p) { return p.name; });

			renderCharts(chartNode, data, toggleHidden);
			renderTable(tableNode, data, function(key) {
				if (data.mode === 'protocols') state.protocol = key;
				else state.mac = key;
				refresh();
			}, toggleHidden);
			renderHidden(data);

			const st = (state.status && state.status.status) || {};
			const age = data.last_sample ? Math.max(0, Math.round(Date.now() / 1000) - data.last_sample) : null;
			const bits = [
				_('Sampler') + ': ' + (st['sampler'] || _('unknown')),
				age === null ? _('no sample taken yet') : _('last sample') + ' ' + age + ' s ' + _('ago'),
				_('resolution') + ': ' + Math.max(1, Math.round(data.step / 60)) + ' ' + _('min per bar')
			];
			if (data.coarse)
				bits.push(_('protocol data is stored in coarser buckets than per-device data, so short spikes are flattened'));
			statusNode.textContent = bits.join(' \u2014 ');
		}

		function refresh(polled) {
			const w = rangeWindow(state.range);
			// A month that is over cannot gain samples, and aggregating one is
			// the most expensive thing the router does here, so the timer only
			// refreshes the status line once the window has closed.
			if (polled && w.end && w.end <= Date.now() / 1000 && state.data && !state.data.error)
				return callStatus().then(function(st) { state.status = st; paint(); })
					.catch(function() {});
			return Promise.all([
				callStatus().catch(function() { return state.status; }),
				callSeries(w.hours, 160, state.mac, state.protocol, w.end,
					hideParam(state.mac, state.protocol))
					.catch(function(e) { return { error: '' + e }; })
			]).then(function(r) {
				state.status = r[0];
				state.data = r[1];
				paint();
			});
		}

		deviceSel.addEventListener('change', function() { state.mac = deviceSel.value; refresh(); });
		protoSel.addEventListener('change', function() { state.protocol = protoSel.value; refresh(); });
		rangeSel.addEventListener('change', function() {
			const v = rangeSel.value;
			if (v.charAt(0) === 'm') {
				const p = v.substring(1).split('-');
				state.range = { year: +p[0], month: +p[1] };
			}
			else state.range = { hours: +v.substring(1) };
			refresh();
		});
		// Units are a display choice, so nothing has to be fetched again.
		unitsSel.addEventListener('change', function() { saveUnits(unitsSel.value); paint(); });

		poll.add(function() { return refresh(true); }, 60);

		const body = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Bandwidth History')),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;gap:8px 0' }, [
					field(_('Device'), deviceSel),
					field(_('Protocol'), protoSel),
					field(_('Period'), rangeSel),
					field(_('Units'), unitsSel)
				]),
				E('p', { 'class': 'cbi-section-descr', style: 'margin:8px 0 0' },
					_('Pick a device to see what it was doing, or a protocol to see who was using it. Untick a row in the table, or click a legend entry, to drop it from the chart so the rest can use the full height.')),
				hiddenNode,
				statusNode,
				errorNode
			]),
			E('div', { 'class': 'cbi-section' }, [ chartNode ]),
			E('div', { 'class': 'cbi-section' }, [ tableNode ])
		]);

		paint();
		return body;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
