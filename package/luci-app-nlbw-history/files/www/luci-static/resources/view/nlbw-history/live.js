'use strict';
'require view';
'require rpc';
'require poll';
'require uci';
'require nlbw-history.chart as chart';

const callLive = rpc.declare({
	object: 'luci_nlbw_history',
	method: 'live',
	// Both, and in this order: rpc.declare maps positional arguments against
	// this list by index, so a name missing here is an argument silently
	// dropped on the floor rather than an error.
	params: [ 'device', 'protocol' ]
});

const PALETTE = chart.PALETTE;
const OTHER_COLOR = chart.OTHER_COLOR;

let state = { data: null, paused: false, mac: '', proto: '' };

// Devices taken out of the stack so the rest can use the full height. Kept
// apart from the history page's own set: the two pages answer different
// questions, and something hidden because it dwarfs a month of history is not
// necessarily something you want gone from a live chart.
// Whether a rate reads in bits or in bytes. Bits by default, which is how
// link speeds are quoted and what every other bandwidth graph on the router
// shows. A display choice, so it lives in the browser and needs no refetch.
let RATEUNIT = 'bit';

function loadRateUnit() {
	const v = chart.stored('nlbw-history.live-rate-unit');
	RATEUNIT = (v === 'byte') ? 'byte' : 'bit';
}

function saveRateUnit(v) {
	RATEUNIT = (v === 'byte') ? 'byte' : 'bit';
	chart.store('nlbw-history.live-rate-unit', RATEUNIT);
}

// Takes bytes per second, which is what the ring holds.
function fmtR(bps) {
	return (RATEUNIT === 'byte') ? chart.fmtByteRate(bps) : chart.fmtRate(bps * 8);
}

let hidden = { devices: {}, protocols: {} };

function dimOf(data) {
	return (data && data.mode === 'protocols') ? 'protocols' : 'devices';
}

function loadHidden() {
	hidden = { devices: {}, protocols: {} };
	const raw = chart.stored('nlbw-history.live-hidden');
	if (!raw) return;
	try {
		const o = JSON.parse(raw) || {};
		for (let k of o.devices || []) hidden.devices[k] = true;
		for (let k of o.protocols || []) hidden.protocols[k] = true;
	}
	catch (e) {}
}

function saveHidden() {
	chart.store('nlbw-history.live-hidden', JSON.stringify({
		devices: Object.keys(hidden.devices),
		protocols: Object.keys(hidden.protocols)
	}));
}

// The table follows whatever is stacked, as it does on the history page.
function stackRows(data) {
	return ((dimOf(data) === 'protocols') ? data.protocols : data.devices) || [];
}

// mac -> name, straight from the backend, which resolves them exactly as
// nlbw-history-query does. Doing it here client side instead would let the two
// pages disagree about what a device is called.
let NAMES = {};

function loadNames(data) {
	NAMES = {};
	for (let d of (data && data.devices) || [])
		if (d.name && d.name !== d.mac) NAMES[d.mac] = d.name;
}

// Protocols are already named by the backend, devices are keyed by MAC.
function keyLabel(key) {
	if (key === 'other') return _('Other');
	return NAMES[key] || key;
}

function stackedBy(data) {
	return (data && data.mode === 'protocols') ? _('by protocol') : _('by device');
}

// Bars hold bytes, the axis holds a rate: this page answers "how fast right
// now", where bytes per three seconds is not a number anyone reads. The bar
// width is stated in the corner the same way the history page states it.
function ratesOf(data, field) {
	const times = data.times || [];
	const out = {};
	for (let k of Object.keys(data.series || {})) {
		out[k] = [];
		for (let i = 0; i < times.length; i++) {
			let span = (i > 0) ? (times[i] - times[i - 1]) : data.interval;
			if (!(span > 0)) span = data.interval || 1;
			out[k][i] = (data.series[k][field][i] || 0) / span;
		}
	}
	return out;
}

function renderCharts(node, data, onToggle) {
	const times = data.times || [];
	const dim = dimOf(data);
	const keys = Object.keys(data.series || {}).filter(function(k) { return !hidden[dim][k]; });

	if (!times.length || !keys.length) {
		node.innerHTML = '';
		node.appendChild(E('p', {}, !times.length
			? _('Waiting for the first samples. The sampler starts with this page.')
			: _('Everything is hidden. Tick a row in the table below to bring it back.')));
		return;
	}

	const rank = {};
	if (data.mode !== 'protocols')
		(data.devices || []).forEach(function(d, i) { rank[d.mac] = i; });
	keys.sort(function(a, b) {
		if (a === 'other') return 1;
		if (b === 'other') return -1;
		return (rank[a] === undefined ? 1e9 : rank[a]) - (rank[b] === undefined ? 1e9 : rank[b]);
	});

	const colors = keys.map(function(k, i) { return chart.colorAt(i, k); });
	const labels = keys.map(keyLabel);
	const corner = _('per') + ' ' + chart.fmtSpan(data.interval || 1);

	function one(field, title) {
		const rate = ratesOf(data, field);
		return chart.svg({
			n: times.length,
			keys: keys,
			labels: labels,
			colors: colors,
			value: function(k, i) { return (rate[k] && rate[k][i]) || 0; },
			fmtY: function(v) { return fmtR(v); },
			xLabel: function(i) {
				const j = Math.min(Math.round(i * (times.length - 1) / 6), times.length - 1);
				return chart.fmtClock(times[j]);
			},
			title: title,
			corner: corner,
			tip: function(k, i, v) {
				const ki = keys.indexOf(k);
				return chart.fmtClock(times[i]) + '  ' + labels[ki] + '  ' + fmtR(v);
			}
		});
	}

	const by = stackedBy(data);
	node.innerHTML = one('rx', _('Download') + ' ' + by) +
	                 one('tx', _('Upload') + ' ' + by);
	node.appendChild(chart.legend(keys, labels, colors, onToggle));
}

function renderTable(node, data, onPick, onToggle) {
	node.innerHTML = '';

	const dim = dimOf(data);
	const proto = (dim === 'protocols');
	const rows = stackRows(data);
	if (!rows.length)
		return;

	const span = data.last_span || data.interval || 1;
	const top = (rows[0].rx + rows[0].tx) || 1;
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
					title: proto ? _('Show only this protocol') : _('Show only this device'),
					click: function(ev) { ev.preventDefault(); onPick(key); }
				}, proto ? r.name : (r.name || r.mac)),
				(!proto && r.name && r.name !== r.mac)
					? E('span', { style: 'opacity:0.6' }, ' (' + r.mac + ')') : ''
			]),
			E('td', { 'class': 'td', style: 'text-align:right' }, fmtR(r.rx_now / span)),
			E('td', { 'class': 'td', style: 'text-align:right' }, fmtR(r.tx_now / span)),
			E('td', { 'class': 'td', style: 'text-align:right' }, chart.fmtBytes(total)),
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
		loadHidden();
		loadRateUnit();
		return Promise.all([
			uci.load('nlbw-history').catch(function() { return null; }),
			callLive('', '').catch(function(e) { return { error: '' + e }; })
		]);
	},

	render: function(res) {
		state.data = res[1];
		chart.loadUnits();
		chart.loadFormats(uci);
		loadNames(state.data);

		const chartNode = E('div', {});
		const tableNode = E('div', {});
		const hiddenNode = E('div', { style: 'font-size:13px;margin-top:8px' });
		const statusNode = E('div', { style: 'font-size:13px;opacity:0.75;margin-top:8px' });
		const warnNode = E('div', { 'class': 'alert-message warning', style: 'display:none' });
		const pauseBtn = E('button', { 'class': 'btn' }, _('Pause'));
		const deviceSel = E('select', { 'class': 'cbi-input-select', style: 'min-width:240px' });
		const protoSel = E('select', { 'class': 'cbi-input-select', style: 'min-width:140px' });
		const unitsSel = E('select', { 'class': 'cbi-input-select' }, [
			E('option', Object.assign({ value: 'bit' },
				RATEUNIT === 'bit' ? { selected: 'selected' } : {}), 'Mbit/s'),
			E('option', Object.assign({ value: 'byte' },
				RATEUNIT === 'byte' ? { selected: 'selected' } : {}), 'MB/s')
		]);

		function field(label, control) {
			return E('span', { style: 'display:flex;align-items:center;gap:6px;margin-right:16px' },
				[ E('label', {}, label), control ]);
		}

		// A filter is kept selectable even once its traffic has stopped, or it
		// would drop itself the moment the device or protocol went quiet.
		function fillSelect(sel, current, allLabel, items, valueOf, labelOf) {
			sel.innerHTML = '';
			sel.appendChild(E('option', { value: '' }, allLabel));
			let found = false;
			for (let it of items || []) {
				const v = valueOf(it);
				if (v === current) found = true;
				sel.appendChild(E('option', { value: v }, labelOf(it)));
			}
			if (current && !found)
				sel.appendChild(E('option', { value: current }, current));
			sel.value = current;
		}

		function fillFilters(data) {
			fillSelect(deviceSel, state.mac, _('All devices'), data.devices,
				function(d) { return d.mac; },
				function(d) { return (d.name && d.name !== d.mac) ? (d.name + ' (' + d.mac + ')') : d.mac; });
			fillSelect(protoSel, state.proto, _('All protocols'), data.protocols,
				function(p) { return p.name; },
				function(p) { return p.name; });
		}

		function toggleHidden(key) {
			const dim = dimOf(state.data);
			if (hidden[dim][key]) delete hidden[dim][key];
			else hidden[dim][key] = true;
			saveHidden();
			paint();
		}

		function renderHidden() {
			const dim = dimOf(state.data);
			const keys = Object.keys(hidden[dim]);
			hiddenNode.innerHTML = '';
			if (!keys.length)
				return;
			hiddenNode.appendChild(E('span', { style: 'opacity:0.75' },
				(dim === 'protocols' ? _('Hidden protocols') : _('Hidden devices')) +
				': ' + keys.map(keyLabel).join(', ') + ' — '));
			hiddenNode.appendChild(E('a', {
				href: '#',
				click: function(ev) {
					ev.preventDefault();
					hidden[dimOf(state.data)] = {};
					saveHidden();
					paint();
				}
			}, _('show all')));
		}

		function paint() {
			const d = state.data;
			if (!d || d.error) {
				warnNode.style.display = '';
				warnNode.textContent = (d && d.error) || _('No data returned.');
				chartNode.innerHTML = '';
				tableNode.innerHTML = '';
				hiddenNode.innerHTML = '';
				statusNode.textContent = '';
				return;
			}

			if (d.accounting === false) {
				warnNode.style.display = '';
				warnNode.textContent = _('conntrack has no byte counters, so there is nothing to chart. Enable them with') +
					': sysctl -w net.netfilter.nf_conntrack_acct=1';
			}
			else {
				warnNode.style.display = 'none';
			}

			fillFilters(d);
			renderCharts(chartNode, d, toggleHidden);
			renderTable(tableNode, d, function(key) {
				if (dimOf(d) === 'protocols') state.proto = key;
				else state.mac = key;
				refresh();
			}, toggleHidden);
			renderHidden();

			const bits = [
				_('Sampler') + ': ' + (d.sampler || _('unknown')),
				_('source') + ': ' + (d.source || '?'),
				_('resolution') + ': ' + chart.fmtSpan(d.interval || 1) + ' ' + _('per bar'),
				_('window') + ': ' + chart.fmtSpan(d.window || 0)
			];
			if (state.paused) bits.push(_('paused'));
			statusNode.textContent = bits.join(' — ');
		}

		function refresh() {
			if (state.paused) return Promise.resolve();
			return callLive(state.mac, state.proto).then(function(d) {
				state.data = d;
				loadNames(d);
				paint();
			}).catch(function(e) {
				state.data = { error: '' + e };
				paint();
			});
		}

		// Repaint at once from what is already loaded so the chart reacts to
		// the click, then refetch: the backend restacks by protocol.
		deviceSel.addEventListener('change', function() {
			state.mac = deviceSel.value;
			refresh();
		});
		protoSel.addEventListener('change', function() {
			state.proto = protoSel.value;
			refresh();
		});
		// Display only, so nothing has to be fetched again.
		unitsSel.addEventListener('change', function() {
			saveRateUnit(unitsSel.value);
			paint();
		});

		pauseBtn.addEventListener('click', function() {
			state.paused = !state.paused;
			pauseBtn.textContent = state.paused ? _('Resume') : _('Pause');
			paint();
		});

		// The poll interval follows the bar width, and each poll doubles as
		// the signal that keeps the on demand sampler alive: stop polling and
		// it shuts itself down.
		let iv = parseInt(uci.get('nlbw-history', 'main', 'live_interval'), 10);
		if (!(iv >= 1 && iv <= 60)) iv = 3;
		poll.add(refresh, iv);

		const body = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Live Bandwidth')),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;gap:8px 0' },
					[ field(_('Device'), deviceSel), field(_('Protocol'), protoSel),
					  field(_('Units'), unitsSel), pauseBtn ]),
				E('p', { 'class': 'cbi-section-descr', style: 'margin:8px 0 0' },
					_('Read straight from conntrack rather than nlbwmon, and nothing is stored. ' +
					  'Sampling runs only while this page is open. Pick a device to see which ' +
					  'protocols it is using, or a protocol to see who is using it. Untick a row ' +
					  'in the table, or click a legend entry, to drop it from the chart so the ' +
					  'rest can use the full height.')),
				hiddenNode,
				statusNode,
				warnNode
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
