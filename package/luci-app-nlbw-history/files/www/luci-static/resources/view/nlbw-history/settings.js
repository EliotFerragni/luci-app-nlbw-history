'use strict';
'require view';
'require form';
'require rpc';

const callStatus = rpc.declare({
	object: 'luci_nlbw_history',
	method: 'status'
});

return view.extend({
	load: function() {
		return callStatus().catch(function() { return null; });
	},

	render: function(res) {
		const st = (res && res.status) || {};
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
			  'is not writing to flash every interval. Graphs still include the buffered samples. ' +
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

		return m.render();
	}
});
