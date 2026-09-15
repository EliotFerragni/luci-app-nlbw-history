'use strict';
'require view';
'require form';
'require rpc';
'require ui';

const callStatus = rpc.declare({
	object: 'luci_nlbw_history',
	method: 'status'
});

const callScrub = rpc.declare({
	object: 'luci_nlbw_history',
	method: 'scrub',
	params: [ 'apply' ]
});

function scrubOutput(res) {
	return E('pre', {
		style: 'max-height:18em;overflow:auto;white-space:pre-wrap;margin:1em 0'
	}, (res && res.output) || _('No output.'));
}

// Never rewrites anything on the first click: the dry run is shown, and the
// button that changes stored history is the second one.
function runScrub() {
	ui.showModal(_('Checking stored history'), [ E('p', { 'class': 'spinning' }, _('Reading the day files…')) ]);
	return callScrub(false).then(function(res) {
		ui.hideModal();
		ui.showModal(_('Clean up stored history'), [
			scrubOutput(res),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', click: ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-negative',
					click: function() {
						ui.showModal(_('Cleaning up'), [ E('p', { 'class': 'spinning' }, _('Rewriting the day files…')) ]);
						return callScrub(true).then(function(done) {
							ui.showModal(_('Done'), [
								scrubOutput(done),
								E('div', { 'class': 'right' },
									E('button', { 'class': 'btn', click: ui.hideModal }, _('Close')))
							]);
						}).catch(function(e) {
							ui.hideModal();
							ui.addNotification(null, E('p', {}, _('Clean up failed') + ': ' + e));
						});
					}
				}, _('Move them out of the history'))
			])
		]);
	}).catch(function(e) {
		ui.hideModal();
		ui.addNotification(null, E('p', {}, _('Check failed') + ': ' + e));
	});
}

return view.extend({
	load: function() {
		return callStatus().catch(function() { return null; });
	},

	render: function(res) {
		const st = (res && res.status) || {};
		const lv = (res && res.live) || {};
		let m, s, o;

		m = new form.Map('nlbw-history', _('Bandwidth History'),
			_('Settings for the sampler behind Services → Bandwidth History. ' +
			  'It reads nlbwmon\'s counters only.'));

		s = m.section(form.NamedSection, 'main', 'nlbw_history', _('Current state'));
		s.anonymous = true;
		s.addremove = false;

		// Option names become DOM ids, so they cannot carry the spaces that
		// some of the status keys have.
		function info(id, key, label) {
			o = s.option(form.DummyValue, '_' + id, label);
			o.cfgvalue = function() { return st[key] || _('unknown'); };
		}

		info('sampler', 'sampler', _('Sampler'));
		info('nlbwmon', 'nlbwmon', _('nlbwmon'));
		info('last', 'last sample', _('Last sample'));
		info('protocols', 'protocols', _('Protocol recording'));
		info('stored', 'stored', _('Stored history'));
		info('spool', 'spool', _('Buffered in RAM'));
		info('discarded', 'discarded', _('Discarded samples'));

		// From nlbwmon's own local_network list, which is what decides whose
		// traffic either page counts.
		o = s.option(form.DummyValue, '_subnets', _('Local networks'),
			_('Read from nlbwmon\'s own local_network list. A connection is counted only when ' +
			  'exactly one end is inside one of these, so traffic between two local hosts, or ' +
			  'to the router itself, appears on neither page.'));
		o.cfgvalue = function() { return lv['local subnets'] || _('unknown'); };

		s = m.section(form.NamedSection, 'main', 'nlbw_history', _('Sampling'));
		s.anonymous = true;
		s.addremove = false;

		o = s.option(form.Value, 'period', _('Sampling interval'),
			_('Seconds between samples. This is the finest detail the graphs can show. ' +
			  'A change takes effect within one interval, no restart needed.'));
		o.datatype = 'range(5,3600)';
		o.placeholder = '60';
		o.value('15', _('15 seconds'));
		o.value('30', _('30 seconds'));
		o.value('60', _('1 minute'));
		o.value('300', _('5 minutes'));

		o = s.option(form.Value, 'retention', _('Keep history for'),
			_('Days. Older day files are deleted at the next write.'));
		o.datatype = 'range(1,3650)';
		o.placeholder = '30';
		o.value('7', _('7 days'));
		o.value('30', _('30 days'));
		o.value('90', _('90 days'));
		o.value('365', _('1 year'));

		o = s.option(form.Value, 'max_rate', _('Reject samples above'),
			_('Mbit/s. A sample claiming more traffic than this link could have carried since ' +
			  'the previous one is recorded as discarded rather than charted, because a flow ' +
			  'offload counter glitch can fold a bogus terabyte into the counters in one go. ' +
			  'Set it to the fastest link a device here can use. 0 accepts every sample.'));
		o.datatype = 'range(0,1000000)';
		o.placeholder = '10000';
		o.value('0', _('Accept everything'));
		o.value('1000', _('1 Gbit/s'));
		o.value('2500', _('2.5 Gbit/s'));
		o.value('10000', _('10 Gbit/s'));

		o = s.option(form.Button, '_scrub', _('Stored history'),
			_('History recorded before this ceiling existed, or while it was higher, can still ' +
			  'hold an implausible spike. This checks the stored day files and shows what it ' +
			  'would move before changing anything.'));
		o.inputtitle = _('Check for implausible rows');
		o.inputstyle = 'apply';
		o.onclick = runScrub;

		s = m.section(form.NamedSection, 'main', 'nlbw_history', _('Protocols'));
		s.anonymous = true;
		s.addremove = false;

		o = s.option(form.Flag, 'protocols', _('Record protocols'),
			_('Also record which protocol each device was using, so you can filter the graphs ' +
			  'by protocol. Costs one extra query to nlbwmon per sample and more storage.'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Value, 'protocol_interval', _('Protocol resolution'),
			_('Seconds per stored protocol bucket. The protocol dimension multiplies the number ' +
			  'of rows, so this is deliberately coarser than the sampling interval. Protocol ' +
			  'graphs cannot show detail finer than this.'));
		o.datatype = 'range(60,86400)';
		o.placeholder = '900';
		o.value('300', _('5 minutes'));
		o.value('900', _('15 minutes'));
		o.value('3600', _('1 hour'));
		o.depends('protocols', '1');

		s = m.section(form.NamedSection, 'main', 'nlbw_history', _('Live view'));
		s.anonymous = true;
		s.addremove = false;

		o = s.option(form.Value, 'live_interval', _('Seconds per bar'),
			_('The Live tab reads conntrack directly rather than nlbwmon, and stores nothing. ' +
			  'Offloaded connections only reach conntrack about every 3 seconds, a tenth of ' +
			  'net.netfilter.nf_conntrack_tcp_timeout_offload, so finer bars than that need ' +
			  'that sysctl lowered as well or they will simply be empty most of the time.'));
		o.datatype = 'range(1,60)';
		o.placeholder = '3';
		o.value('1', _('1 second'));
		o.value('3', _('3 seconds'));
		o.value('5', _('5 seconds'));
		o.value('10', _('10 seconds'));

		o = s.option(form.Value, 'live_window', _('Live window'),
			_('Seconds kept in RAM, which is how much of the recent past the live chart shows. ' +
			  'Nothing here is written to storage.'));
		o.datatype = 'range(30,3600)';
		o.placeholder = '180';
		o.value('60', _('1 minute'));
		o.value('180', _('3 minutes'));
		o.value('600', _('10 minutes'));

		s = m.section(form.NamedSection, 'main', 'nlbw_history', _('Storage'));
		s.anonymous = true;
		s.addremove = false;

		o = s.option(form.Value, 'data_dir', _('History directory'),
			_('Must survive a reboot. On OpenWrt /tmp and /var are RAM, so a path there ' +
			  'would lose the whole history every time the router restarts.'));
		o.placeholder = '/srv/nlbw-history';
		o.rmempty = false;
		o.validate = function(section_id, value) {
			if (!value || value.charAt(0) !== '/')
				return _('Enter an absolute path.');
			if (/^\/(tmp|var|proc|sys|dev)(\/|$)/.test(value))
				return _('That path is in RAM or a virtual filesystem; the history would not survive a reboot.');
			return true;
		};

		o = s.option(form.Value, 'flush_interval', _('Write to storage every'),
			_('Seconds. Samples are buffered in RAM and written out in batches so the router ' +
			  'is not writing to flash every interval. The graphs still include the buffered ' +
			  'samples. ' +
			  'A hard power cut loses at most this much history.'));
		o.datatype = 'range(30,86400)';
		o.placeholder = '600';
		o.value('60', _('1 minute'));
		o.value('600', _('10 minutes'));
		o.value('1800', _('30 minutes'));
		o.value('3600', _('1 hour'));

		s = m.section(form.NamedSection, 'main', 'nlbw_history', _('Display'));
		s.anonymous = true;
		s.addremove = false;

		o = s.option(form.ListValue, 'time_format', _('Clock'),
			_('How the graphs print times. Automatic follows the browser the page is open in.'));
		o.value('auto', _('Automatic'));
		o.value('24', _('24 hour (14:05)'));
		o.value('12', _('12 hour (2:05 PM)'));
		o.default = 'auto';

		o = s.option(form.ListValue, 'date_format', _('Date order'),
			_('How the graphs print dates. Automatic follows the browser the page is open in.'));
		o.value('auto', _('Automatic'));
		o.value('dmy', _('Day first (31/12)'));
		o.value('mdy', _('Month first (12/31)'));
		o.default = 'auto';

		return m.render();
	}
});
