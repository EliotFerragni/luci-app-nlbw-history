'use strict';
'require view';
'require rpc';
'require poll';

const callSeries = rpc.declare({
	object: 'luci_nlbw_history',
	method: 'series',
	params: [ 'hours', 'buckets', 'mac', 'protocol' ]
});

const callStatus = rpc.declare({
	object: 'luci_nlbw_history',
	method: 'status'
});

const PALETTE = [ '#3d6fb4', '#d98032', '#4e9e6a', '#c2504f', '#7a6bab',
                  '#3aa3a8', '#b4699b', '#8a7f6d' ];
const OTHER_COLOR = '#9aa3ac';

let state = { mac: '', protocol: '', hours: 24, data: null, status: null };

// 'si' counts in thousands and prints MB, 'iec' counts in 1024s and prints MiB.
let UNITS = 'si';

function loadUnits() {
	try { UNITS = window.localStorage.getItem('nlbw-history.units') || 'si'; }
	catch (e) { UNITS = 'si'; }
	if (UNITS !== 'si' && UNITS !== 'iec') UNITS = 'si';
}

function saveUnits(v) {
	UNITS = v;
	try { window.localStorage.setItem('nlbw-history.units', v); } catch (e) {}
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

function fmtTime(ts, span) {
	const d = new Date(ts * 1000);
	if (span <= 48 * 3600)
		return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' }) + ' ' +
	       d.toLocaleTimeString([], { hour: '2-digit' });
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

function renderCharts(node, data) {
	const keys = Object.keys(data.series || {});
	if (!keys.length) {
		node.innerHTML = '';
		node.appendChild(E('p', {}, _('No traffic recorded in this period yet.')));
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
		legend.appendChild(E('span', { style: 'display:flex;align-items:center;gap:6px' }, [
			E('i', { style: 'width:11px;height:11px;border-radius:2px;background:' + colors[i] }),
			labels[i]
		]));
	});
	node.appendChild(legend);
}

function renderTable(node, data, onPick) {
	node.innerHTML = '';

	const proto = data.mode === 'protocols';
	const rows = (proto ? data.protocols : data.devices) || [];
	if (!rows.length)
		return;

	const top = rows[0].rx + rows[0].tx || 1;
	const out = [ E('tr', { 'class': 'tr table-titles' }, [
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
		const color = r.charted ? PALETTE[(i++) % PALETTE.length] : OTHER_COLOR;
		out.push(E('tr', { 'class': 'tr' }, [
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
		return Promise.all([
			callStatus().catch(function() { return null; }),
			callSeries(24, 160, '', '').catch(function(e) { return { error: '' + e }; })
		]);
	},

	render: function(res) {
		state.status = res[0];
		state.data = res[1];
		loadUnits();

		const deviceSel = E('select', { 'class': 'cbi-input-select', style: 'min-width:240px;margin-right:12px' });
		const protoSel = E('select', { 'class': 'cbi-input-select', style: 'min-width:140px;margin-right:12px' });
		const hoursSel = E('select', { 'class': 'cbi-input-select', style: 'margin-right:12px' });
		const unitsSel = E('select', { 'class': 'cbi-input-select' }, [
			E('option', Object.assign({ value: 'si' }, UNITS === 'si' ? { selected: 'selected' } : {}),
				_('MB (1000 bytes per kB)')),
			E('option', Object.assign({ value: 'iec' }, UNITS === 'iec' ? { selected: 'selected' } : {}),
				_('MiB (1024 bytes per KiB)'))
		]);

		[ [ 1, _('Last hour') ], [ 6, _('Last 6 hours') ], [ 24, _('Last 24 hours') ],
		  [ 72, _('Last 3 days') ], [ 168, _('Last 7 days') ], [ 720, _('Last 30 days') ] ]
			.forEach(function(o) {
				hoursSel.appendChild(E('option', Object.assign({ value: o[0] },
					o[0] === state.hours ? { selected: 'selected' } : {}), o[1]));
			});

		const chartNode = E('div', {});
		const tableNode = E('div', {});
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

		function paint() {
			const data = state.data;
			if (!data || data.error) {
				errorNode.style.display = '';
				errorNode.textContent = (data && data.error) || _('No data returned.');
				chartNode.innerHTML = '';
				tableNode.innerHTML = '';
				return;
			}
			errorNode.style.display = 'none';

			fillSelect(deviceSel, state.mac, _('All devices'), data.devices,
				function(d) { return d.mac; },
				function(d) { return (d.name && d.name !== d.mac) ? d.name + ' (' + d.mac + ')' : d.mac; });
			fillSelect(protoSel, state.protocol, _('All protocols'), data.protocols,
				function(p) { return p.name; },
				function(p) { return p.name; });

			renderCharts(chartNode, data);
			renderTable(tableNode, data, function(key) {
				if (data.mode === 'protocols') state.protocol = key;
				else state.mac = key;
				refresh();
			});

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

		function refresh() {
			return Promise.all([
				callStatus().catch(function() { return state.status; }),
				callSeries(state.hours, 160, state.mac, state.protocol)
					.catch(function(e) { return { error: '' + e }; })
			]).then(function(r) {
				state.status = r[0];
				state.data = r[1];
				paint();
			});
		}

		deviceSel.addEventListener('change', function() { state.mac = deviceSel.value; refresh(); });
		protoSel.addEventListener('change', function() { state.protocol = protoSel.value; refresh(); });
		hoursSel.addEventListener('change', function() { state.hours = +hoursSel.value; refresh(); });
		// Units are a display choice, so nothing has to be fetched again.
		unitsSel.addEventListener('change', function() { saveUnits(unitsSel.value); paint(); });

		poll.add(refresh, 60);

		const body = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Bandwidth History')),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;gap:6px' }, [
					E('label', {}, _('Device')), deviceSel,
					E('label', {}, _('Protocol')), protoSel,
					E('label', {}, _('Period')), hoursSel,
					E('label', {}, _('Units')), unitsSel
				]),
				E('p', { 'class': 'cbi-section-descr', style: 'margin:8px 0 0' },
					_('Pick a device to see what it was doing, or a protocol to see who was using it.')),
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
