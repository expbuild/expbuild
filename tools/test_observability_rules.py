#!/usr/bin/env python3
"""Render shipped Helm rules and replay firing/recovery samples with promtool."""
import argparse
from pathlib import Path
import subprocess
import tempfile
import yaml

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--helm',required=True)
parser.add_argument('--promtool',required=True)
args=parser.parse_args()
root=Path(__file__).resolve().parent.parent
chart=root/'deploy/charts/expbuild'
rendered=subprocess.check_output([args.helm,'template','test',str(chart),'-f',str(chart/'ci-values.yaml'),'--set','monitoring.platform.enabled=true,monitoring.platform.tokenSecret=metrics-auth,monitoring.platform.rules=true'],text=True)
rule=next(doc['spec'] for doc in yaml.safe_load_all(rendered) if doc and doc.get('kind')=='PrometheusRule')
cluster='expbuild_cluster_id="primary"'
identity=cluster+',expbuild_project_id="project",expbuild_instance_uid="instance"'
labels={'expbuild_cluster_id':'primary','expbuild_project_id':'project','expbuild_instance_uid':'instance','severity':'warning','scope':'instance'}
def alert(name,time,summary,expected=True,extra=None):
    return {'eval_time':time,'alertname':name,'exp_alerts':[{'exp_labels':extra or labels,'exp_annotations':{'summary':summary}}] if expected else []}
tests=[{
 'name':'API error rate carries cluster identity and clears after traffic stops',
 'interval':'1m',
 'input_series':[
  {'series':f'expbuild_observation_collector_leader{{{cluster}}}','values':'1x20'},
  {'series':f'expbuild_api_requests_total{{{cluster},status_class="5xx"}}','values':'0+20x6 120x14'},
  {'series':f'expbuild_api_requests_total{{{cluster},status_class="2xx"}}','values':'0+80x6 480x14'},
 ],
 'alert_rule_test':[
  alert('ExpbuildAPIServiceErrors','6m','Management API error rate exceeds 5 percent with sufficient traffic.',extra={'expbuild_cluster_id':'primary','severity':'warning','scope':'platform'}),
  alert('ExpbuildAPIServiceErrors','13m','',False),
 ]
},{
 'name':'readiness alert fires after grace and clears on suspension; telemetry failure is separate',
 'interval':'1m',
 'input_series':[
  {'series':f'expbuild_observation_collector_leader{{{cluster}}}','values':'1x25'},
  {'series':f'expbuild_instance_ready{{{identity}}}','values':'0x25'},
  {'series':f'expbuild_instance_expected_running{{{identity}}}','values':'1x11 0x14'},
  {'series':f'expbuild_instance_statistics_available{{{identity}}}','values':'0x25'},
 ],
 'alert_rule_test':[
  alert('ExpbuildInstanceNotReady','9m','',False),
  alert('ExpbuildInstanceNotReady','11m','The running instance has not reached current-generation readiness. Inspect its operation timeline.'),
  alert('ExpbuildInstanceNotReady','13m','',False),
  alert('ExpbuildInstanceStatisticsUnavailable','6m','Instance statistics are unavailable. Check collection separately from cache readiness.'),
  alert('ExpbuildInstanceStatisticsUnavailable','13m','',False),
 ]
},{
 'name':'scrape failure does not claim service failure',
 'interval':'1m',
 'input_series':[
  {'series':f'expbuild_observation_collector_leader{{{cluster}}}','values':'1x8'},
  {'series':f'up{{{cluster},expbuild_component="api"}}','values':'0x3 1x4'},
 ],
 'alert_rule_test':[
  alert('ExpbuildMonitoringTargetUnavailable','3m','Monitoring target unavailable; this does not establish cache service failure.',extra={'expbuild_cluster_id':'primary','expbuild_component':'api','severity':'warning','scope':'platform'}),
  alert('ExpbuildMonitoringTargetUnavailable','5m','',False),
  alert('ExpbuildInstanceNotReady','3m','',False),
 ]
},{
 'name':'missing collector is observable',
 'interval':'1m','input_series':[],
 'alert_rule_test':[alert('ExpbuildObservationCollectorUnavailable','3m','No active instance observation collector. Check management API replicas and database connectivity.',extra={'expbuild_cluster_id':'primary','severity':'warning','scope':'platform'})]
}]
with tempfile.TemporaryDirectory(prefix='expbuild-rule-tests-') as directory:
    directory=Path(directory)
    rules=directory/'rules.yaml';rules.write_text(yaml.safe_dump(rule))
    fixture=directory/'tests.yaml';fixture.write_text(yaml.safe_dump({'rule_files':[str(rules)],'evaluation_interval':'1m','tests':tests}))
    subprocess.run([args.promtool,'check','rules',str(rules)],check=True)
    subprocess.run([args.promtool,'test','rules',str(fixture)],check=True)
