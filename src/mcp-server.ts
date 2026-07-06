import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const DEFAULT_BASE_URL = "https://hermes.dcism.org"
const getBaseUrl = () => {
  return process.env.HERMES_API_BASE_URL || process.env.VITE_BASE_URL || DEFAULT_BASE_URL
}

const COURSES = ["BSCS", "BSIT", "BSIS"] as const
type Course = (typeof COURSES)[number]

const isValidCourse = (course: string | undefined | null): course is Course => {
  return typeof course === "string" && (COURSES as readonly string[]).includes(course)
}

const fetchQueueData = async (course: Course) => {
  const baseUrl = getBaseUrl()
  const [queueRes, coordinatorRes] = await Promise.all([
    fetch(`${baseUrl}/queue/${course}/number/current`),
    fetch(`${baseUrl}/coordinator/${course}`),
  ])

  if (!queueRes.ok) {
    throw new Error(`Failed to fetch queue info for ${course}: ${queueRes.statusText}`)
  }
  if (!coordinatorRes.ok) {
    throw new Error(`Failed to fetch coordinator info for ${course}: ${coordinatorRes.statusText}`)
  }

  const queueData = (await queueRes.json()) as {
    current: number
    max: number
    queuedStudents: Array<{
      queueNumber: number
      student: { id: string; name: string } | null
    }>
  }

  const coordinatorData = (await coordinatorRes.json()) as {
    id: number
    name: string
    courseName: string
    status: string
    email: string
  }

  return {
    course,
    coordinator: coordinatorData.name,
    status: coordinatorData.status,
    currentServing: queueData.current === 0 ? "None" : queueData.current,
    totalIssued: queueData.max,
    waitingCount: queueData.queuedStudents.length,
    queuedStudents: queueData.queuedStudents.map((qs) => ({
      queueNumber: qs.queueNumber,
      studentName: qs.student?.name || "Unknown",
      studentId: qs.student?.id || "Unknown",
    })),
  }
}

const server = new Server(
  {
    name: "hermes-queue-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
)

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_queues",
        description:
          "Get queue status (all queues or an individual queue). Includes who is serving, how many students are waiting, and coordinator availability status.",
        inputSchema: {
          type: "object",
          properties: {
            course: {
              type: "string",
              enum: ["BSCS", "BSIT", "BSIS"],
              description: "Optional course/queue name. If omitted, returns all queues.",
            },
          },
        },
      },
      {
        name: "add_to_queue",
        description: "Add a student to a queue given their student ID number and course.",
        inputSchema: {
          type: "object",
          properties: {
            idNumber: {
              type: "string",
              description: "Student ID number (must contain only numbers).",
            },
            course: {
              type: "string",
              enum: ["BSCS", "BSIT", "BSIS"],
              description: "The course queue to join.",
            },
          },
          required: ["idNumber", "course"],
        },
      },
      {
        name: "remove_from_queue",
        description: "Remove a student from their active queue given their student ID number and course.",
        inputSchema: {
          type: "object",
          properties: {
            idNumber: {
              type: "string",
              description: "Student ID number (must contain only numbers).",
            },
            course: {
              type: "string",
              enum: ["BSCS", "BSIT", "BSIS"],
              description: "The course queue the student is currently in.",
            },
          },
          required: ["idNumber", "course"],
        },
      },
    ],
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const baseUrl = getBaseUrl()

  try {
    if (name === "get_queues") {
      const course = args?.course
      if (course && !isValidCourse(course)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid course: ${course}. Must be one of BSCS, BSIT, BSIS.` }],
        }
      }
      if (course) {
        const data = await fetchQueueData(course)
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        }
      }
      const results = await Promise.all(COURSES.map((c) => fetchQueueData(c)))
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      }
    }

    if (name === "add_to_queue") {
      const idNumber = String(args?.idNumber || "").trim()
      const course = args?.course

      if (!idNumber || !/^\d+$/.test(idNumber)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Invalid idNumber. Must be digits only." }],
        }
      }
      if (!course || !isValidCourse(course)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid course: ${course}. Must be one of BSCS, BSIT, BSIS.` }],
        }
      }

      // Step 1: Login to get token
      const loginRes = await fetch(`${baseUrl}/auth/sign-in`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idNumber, course }),
      })

      if (!loginRes.ok) {
        const errText = await loginRes.text()
        return {
          isError: true,
          content: [{ type: "text", text: `Login failed for ID ${idNumber}: ${errText || loginRes.statusText}` }],
        }
      }

      const { token } = (await loginRes.json()) as { token: string }

      // Step 2: Enqueue student
      const enqueueRes = await fetch(`${baseUrl}/queue/${course}/number`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      })

      if (!enqueueRes.ok) {
        const errText = await enqueueRes.text()
        return {
          isError: true,
          content: [{ type: "text", text: `Enqueue failed: ${errText || enqueueRes.statusText}` }],
        }
      }

      const resultData = await enqueueRes.json()
      return {
        content: [
          {
            type: "text",
            text: `Successfully added student ${idNumber} to ${course} queue.\nQueue Details:\n${JSON.stringify(resultData, null, 2)}`,
          },
        ],
      }
    }

    if (name === "remove_from_queue") {
      const idNumber = String(args?.idNumber || "").trim()
      const course = args?.course

      if (!idNumber || !/^\d+$/.test(idNumber)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Invalid idNumber. Must be digits only." }],
        }
      }
      if (!course || !isValidCourse(course)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid course: ${course}. Must be one of BSCS, BSIT, BSIS.` }],
        }
      }

      // Step 1: Login to get token
      const loginRes = await fetch(`${baseUrl}/auth/sign-in`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idNumber, course }),
      })

      if (!loginRes.ok) {
        const errText = await loginRes.text()
        return {
          isError: true,
          content: [{ type: "text", text: `Login failed for ID ${idNumber}: ${errText || loginRes.statusText}` }],
        }
      }

      const { token } = (await loginRes.json()) as { token: string }

      // Step 2: Dequeue student
      const dequeueRes = await fetch(`${baseUrl}/queue/number`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      })

      if (!dequeueRes.ok) {
        const errText = await dequeueRes.text()
        return {
          isError: true,
          content: [{ type: "text", text: `Dequeue failed: ${errText || dequeueRes.statusText}` }],
        }
      }

      const resultData = await dequeueRes.json()
      return {
        content: [
          {
            type: "text",
            text: `Successfully removed student ${idNumber} from the queue.\nDetails:\n${JSON.stringify(resultData, null, 2)}`,
          },
        ],
      }
    }

    throw new Error(`Tool not found: ${name}`)
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : String(error)
    return {
      isError: true,
      content: [{ type: "text", text: `Error executing tool: ${errMessage}` }],
    }
  }
})

// Setup transport mode based on arguments or environment variables
let port = parseInt(process.env.PORT || "3000", 10)
const portIndex = process.argv.indexOf("--port")
if (portIndex !== -1 && portIndex + 1 < process.argv.length) {
  port = parseInt(process.argv[portIndex + 1], 10)
}
const isHttp = process.argv.includes("--http") || process.env.PORT !== undefined || portIndex !== -1

if (isHttp) {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()

  Bun.serve({
    port,
    async fetch(req) {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, MCP-Protocol-Version, mcp-session-id",
          },
        })
      }

      let res: Response
      if (req.method === "GET") {
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
        })
        await server.connect(transport)
        res = await transport.handleRequest(req)
        const sessionId = transport.sessionId
        if (sessionId) {
          sessions.set(sessionId, transport)
          transport.onclose = () => {
            sessions.delete(sessionId)
          }
        }
      } else {
        const sessionId = req.headers.get("mcp-session-id")
        if (!sessionId) {
          res = new Response("Missing mcp-session-id header", { status: 400 })
        } else {
          const transport = sessions.get(sessionId)
          if (!transport) {
            res = new Response("Session not found", { status: 404 })
          } else {
            res = await transport.handleRequest(req)
            if (req.method === "DELETE") {
              sessions.delete(sessionId)
            }
          }
        }
      }

      // Set CORS headers
      const newHeaders = new Headers(res.headers)
      newHeaders.set("Access-Control-Allow-Origin", "*")
      newHeaders.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
      newHeaders.set("Access-Control-Allow-Headers", "Content-Type, MCP-Protocol-Version, mcp-session-id")

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: newHeaders,
      })
    },
  })

  process.stderr.write(`Hermes Queue MCP server running over HTTP on port ${port}...\n`)
} else {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
