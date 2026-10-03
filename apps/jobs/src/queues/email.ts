/**
 * EMAIL_QUEUE 消费者的空壳：只记录收到的消息，发送逻辑在 P1（add-auth-and-workspaces 3.2）实现。
 * 只记录元数据，不记录消息体（今后会包含收件人等个人信息）。
 */
export async function handleEmailBatch(batch: MessageBatch<unknown>): Promise<void> {
  for (const message of batch.messages) {
    console.log(
      JSON.stringify({
        event: 'email.received',
        queue: batch.queue,
        id: message.id,
        attempts: message.attempts,
      }),
    )
    message.ack()
  }
}
