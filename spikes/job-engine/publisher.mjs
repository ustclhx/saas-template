// 故障点：引擎确认后进程退出，尚未标记 outbox。
process.on('message',m=>{if(m.accepted)process.exit(88);process.send(m)})
