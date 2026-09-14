'use strict';
'require view';
'require rpc';
'require poll';
'require uci';
'require nlbw-history.chart as chart';

const callSeries = rpc.declare({
	object: 'luci_nlbw_history',
	method: 'series',
	params: [ 'hours', 'buckets', 'mac', 'protocol', 'end', 'hide' ]
});

const callStatus = rpc.declare({
	object: 'luci_nlbw_history',
	method: 'status'
});

const PALETTE = chart.PALETTE;
const OTHER_COLOR = chart.OTHER_COLOR;

// range is either { hours: n } ending now, or a calendar month { year, month }.
let state = { mac: '', protocol: '', range: { hours: 24 }, data: null, status: null };

// Units and the clock/date formats live in the shared chart module, which is
// what actually formats with them. These keep the names the rest of this file
// already uses.
let UNITS = 'si';
let FORMATS = { time: 'auto', date: 'auto' };

function loadFormats() { chart.loadFormats(uci); FORMATS = chart.formats; }
function stored(key) { return chart.stored(key); }
function store(key, value) { chart.store(key, value); }
function loadUnits() { UNITS = chart.loadUnits(); }
function saveUnits(v) { chart.saveUnits(v); UNITS = v; }
function esc(s) { return chart.esc(s); }
function fmtBytes(n) { return chart.fmtBytes(n); }
function fmtRate(bps) { return chart.fmtRate(bps); }
function fmtTime(ts, span) { return chart.fmtTime(ts, span); }
function fmtSpan(sec) { return chart.fmtSpan(sec); }

// Series taken out of the stack so the rest can use the full height, kept per
// stacked dimension: MACs while devices are stacked, protocol names while
// protocols are. A display choice, so it lives in the browser rather than in
// the router's config.
let hidden = { devices: {}, protocols: {} };

function loadHidden() {
	hidden = { devices: {}, protocols: {} };
	const raw = stored('nlbw-history.hidden');
	if (!raw) return;
	try {
		const saved = JSON.parse(raw) || {};
		[ 'devices', 'protocols' ].forEach(function(dim) {
			for (let k of saved[dim] || [])
				if (typeof k === 'string' && k !== '') hidden[dim][k] = true;
		});
	} catch (e) {}
}

function saveHidden() {
	store('nlbw-history.hidden', JSON.stringify({
		devices: Object.keys(hidden.devices),
		protocols: Object.keys(hidden.protocols)
	}));
}

// Which dimension the chart stacks, and so which hidden set applies: protocols
// when a single device is selected, devices otherwise. The backend decides the
// same way, from the same two filters.
function dimFor(mac, protocol) {
	return (mac && !protocol) ? 'protocols' : 'devices';
}

// The same question once the answer is in the response.
function dimOf(data) {
	return (data && data.mode === 'protocols') ? 'protocols' : 'devices';
}

function hideParam(mac, protocol) {
	return Object.keys(hidden[dimFor(mac, protocol)]).join(',');
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

// Adapter over the shared stacked bar chart: this page indexes its series by
// bucket and labels the axis in bytes, with the rate in the tooltip.
function chartSVG(data, keys, labels, colors, field, title) {
	const step = data.step || 1;
	const span = data.to - data.from;
	return chart.svg({
		n: data.buckets,
		keys: keys,
		labels: labels,
		colors: colors,
		value: function(k, b) { return (data.series[k] && data.series[k][field][b]) || 0; },
		fmtY: function(v) { return chart.fmtBytes(v); },
		xLabel: function(i) { return chart.fmtTime(data.from + span * i / 6, span); },
		title: title,
		corner: _('per') + ' ' + chart.fmtSpan(step),
		tip: function(k, b, v) {
			const i = keys.indexOf(k);
			return chart.fmtTime(data.from + b * step, span) + '  ' + labels[i] + '  ' +
			       chart.fmtBytes(v) + '  (' + chart.fmtRate(v * 8 / step) + ')';
		}
	});
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
	// The backend already leaves hidden keys out. Filtering again is what makes
	// a click rescale the chart at once, without waiting for the refetch.
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

	node.appendChild(chart.legend(keys, labels, colors, onToggle));
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
		const discardNode = E('div', { 'class': 'alert-message warning', style: 'display:none' });

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

		// Its own alert rather than one more clause in the grey status line: an
		// interval with no usable number is worth noticing.
		function renderDiscarded(data) {
			const d = data.discarded;
			if (!d || !d.count) {
				discardNode.style.display = 'none';
				return;
			}
			const span = data.to - data.from;
			const when = (d.first === d.last)
				? fmtTime(d.first, span)
				: fmtTime(d.first, span) + ' \u2013 ' + fmtTime(d.last, span);
			discardNode.style.display = '';
			discardNode.textContent = d.count + ' ' +
				(d.count === 1 ? _('sample was') : _('samples were')) + ' ' +
				_('discarded as implausible') + ' (' + when + '), ' +
				_('so that traffic is missing from the graph. A counter moved further than max_rate allows, which points at a flow offload counter glitch rather than real traffic.') + ' ' +
				_('Run nlbw-history-collect --status for detail.');
		}

		function paint() {
			const data = state.data;
			if (!data || data.error) {
				errorNode.style.display = '';
				errorNode.textContent = (data && data.error) || _('No data returned.');
				chartNode.innerHTML = '';
				tableNode.innerHTML = '';
				hiddenNode.innerHTML = '';
				discardNode.style.display = 'none';
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
			renderDiscarded(data);
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
				errorNode,
				discardNode
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
