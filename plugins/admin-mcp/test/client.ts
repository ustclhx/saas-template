import { Client, type FetchLike, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

export async function connectAdminMcpTestClient(url: URL, token: string, fetch: FetchLike) {
  const client = new Client({ name: 'admin-mcp-integration', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch,
  })
  await client.connect(transport)
  return client
}
