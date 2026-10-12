import subprocess,json,time,pathlib,datetime
p=pathlib.Path('openspec/changes/add-selfhost-job-engine/spike/resources.jsonl')
while True:
 r=subprocess.run(['docker','stats','--no-stream','--format','{{json .}}','selfhost-b-spike-pg'],text=True,capture_output=True)
 if r.returncode:break
 with p.open('a') as f:f.write(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'phase':'both-candidates-real-time','docker':json.loads(r.stdout)})+'\n')
 time.sleep(30)
