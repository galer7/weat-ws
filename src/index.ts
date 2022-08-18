import { Server } from "socket.io";
import { prisma } from "../prisma/client";
import superjson from "superjson";
import { FoodieGroup } from "@prisma/client";
import {
  ClientToServerEvents,
  GroupUserState,
  ServerToClientEvents,
} from "./types";
import { createServer } from "http";

const httpServer = createServer();

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: [
      "http://localhost:*",
      "https://weat-galer7.vercel.app:*",
      "https://weat-rho.vercel.app:*",
      "https://weat.galer7.com:*",
    ],
  },
});

const persistStateChangeAsync = async (
  foodieGroupMap: Map<string, GroupUserState>,
  foodieGroupId: string
) => {
  console.log("persistStateChangeAsync", { foodieGroupMap, foodieGroupId });
  console.log(await prisma.foodieGroup.findMany({ where: {} }));
  await prisma.foodieGroup.update({
    where: { id: foodieGroupId },
    data: { foodieGroupState: superjson.stringify(foodieGroupMap) },
  });
};

const m: Map<string, Map<string, GroupUserState>> = new Map();

(async () => {
  const allFoodieGroups = await prisma.foodieGroup.findMany();
  allFoodieGroups.forEach(
    ({ id, foodieGroupState: stringifiedFoodieGroupState }: FoodieGroup) => {
      if (!stringifiedFoodieGroupState) return;
      m.set(id, superjson.parse(stringifiedFoodieGroupState));
    }
  );

  io.on("connection", async (socket) => {
    io.use(async (socket, next) => {
      console.log("middleware on connection", socket.handshake.auth);
      const token = socket.handshake.auth.token;

      if (!token) {
        next(new Error(`bad token: ${token}`));
        return;
      }

      // if the room was deleted previously or is first login on server
      if (!io.sockets.adapter.rooms.has(token)) {
        const { userId } = await prisma.session.findFirst({
          where: { sessionToken: token },
        });

        await prisma.user.update({
          where: { id: userId },
          data: { online: true },
        });
      }

      socket.join(token);
      next();
    });

    socket.on("user:first:render", (foodieGroupId) => {
      const foodieGroupMap = m.get(foodieGroupId);

      console.log("user:first:render:", { foodieGroupMap, foodieGroupId });
      if (!foodieGroupMap) return;

      socket.join(foodieGroupId);
      socket.emit("server:first:render", superjson.stringify(foodieGroupMap));
    });

    socket.on(
      "user:invite:sent",
      async (from, to, foodieGroupId, fromUserState) => {
        // create room on first group invite sent
        console.log("received user:invite:sent", {
          from,
          to,
          foodieGroupId,
          fromUserState,
        });

        // send to all sockets associated with that userId
        const { sessions } = await prisma.user.findFirst({
          where: { id: to },
          include: { sessions: true },
        });

        console.log("found user's session for invite", sessions);

        sessions.forEach(({ sessionToken }) => {
          io.to(sessionToken).emit(
            "server:invite:sent",
            { name: from.name, id: from.id },
            foodieGroupId
          );
        });
        socket.join(foodieGroupId);

        // if it is the first invite, the sender sends its user state also
        if (!m.has(foodieGroupId)) {
          const [
            { image: fromImage, name: fromName },
            { image: toImage, name: toName },
          ] = await Promise.all([
            prisma.user.findUnique({ where: { id: from.id } }),
            prisma.user.findUnique({ where: { id: to } }),
          ]);

          m.set(
            foodieGroupId,
            new Map([
              [from.id, { ...fromUserState, image: fromImage, name: fromName }],
              [
                to,
                {
                  isInviteAccepted: false,
                  restaurants: [],
                  image: toImage,
                  name: toName,
                },
              ],
            ])
          );
        } else {
          const { image: toImage, name: toName } = await prisma.user.findUnique(
            {
              where: { id: to },
            }
          );

          m.get(foodieGroupId).set(to, {
            name: toName,
            isInviteAccepted: false,
            restaurants: [],
            image: toImage,
          });
        }
        await persistStateChangeAsync(m.get(foodieGroupId), foodieGroupId);

        console.log("map after invite sent", m);
      }
    );

    socket.on(
      "user:invite:response",
      async (userId, foodieGroupId, userState) => {
        const foodieGroupMap = m.get(foodieGroupId);
        if (!foodieGroupMap) return;

        if (userState) {
          // add socket which accepted the invite to the room
          socket.join(foodieGroupId);

          foodieGroupMap.set(userId, userState);
          await persistStateChangeAsync(foodieGroupMap, foodieGroupId);

          // we do this foreach because we want to send the invited user all group user states
          foodieGroupMap.forEach((userState, userId) => {
            io.to(foodieGroupId).emit(
              "server:state:updated",
              superjson.stringify(userState),
              userId
            );
          });
        } else {
          foodieGroupMap.delete(userId);

          if (foodieGroupMap.size === 1) {
            m.delete(foodieGroupId);
          } else {
            await persistStateChangeAsync(foodieGroupMap, foodieGroupId);
          }

          io.to(foodieGroupId).emit(
            "server:state:updated",
            superjson.stringify(undefined),
            userId
          );
        }
      }
    );

    socket.on(
      "user:state:updated",
      async (userId, foodieGroupId, userState) => {
        console.log("received user:state:updated event", {
          userId,
          foodieGroupId,
          userState,
        });

        console.log(m);
        // update group state so that we can render RT updates
        if (!m.get(foodieGroupId)) {
          console.log(`user ${userId} does not exist on FG ${foodieGroupId}`);
          // TODO: remove this, it should theoretically exist already
          m.set(foodieGroupId, new Map());
        }
        const foodieGroupMap = m.get(foodieGroupId);

        let isOnlyOneLeft = false;
        // if userState comes undefined, it means it either left the group or signed-out
        if (!userState) {
          socket.leave(foodieGroupId);
          foodieGroupMap.delete(userId);
          console.log("after delete name", { foodieGroupMap });

          // if there is only one more member in the foodieGroup after another user left, delete the foodieGroup from the in-memory map
          if (foodieGroupMap.size === 1) {
            isOnlyOneLeft = true;
            m.delete(foodieGroupId);
            console.log("after delete foodieGroup", { m });
          }
        } else {
          foodieGroupMap.set(userId, userState);
        }

        if (!isOnlyOneLeft) {
          // the foodieGroup from the DB is deleted through TRPC from Next.js app in this case
          await persistStateChangeAsync(foodieGroupMap, foodieGroupId);
        }

        console.log(m);

        console.log("emit server:state:updated", [
          superjson.stringify(foodieGroupMap.get(userId)),
          userId,
        ]);

        io.to(foodieGroupId).emit(
          "server:state:updated",
          superjson.stringify(userState),
          userId
        );
      }
    );

    socket.on("disconnecting", async () => {
      const token = socket.handshake.auth.token;

      console.log("before disconnect before delete", {
        token,
        socketId: socket.id,
      });

      const isLastSocketForToken =
        io.sockets.adapter.rooms.get(token).size === 1 &&
        io.sockets.adapter.rooms.get(token).values().next().value === socket.id;

      if (!isLastSocketForToken) return;

      // user has no more sockets left, so set to offline
      await prisma.session.update({
        where: { sessionToken: token },
        data: { user: { update: { online: false } } },
      });

      console.log("after disconnect", {
        token,
        socketId: socket.id,
      });
    });
  });

  httpServer.listen(parseInt(process.env.PORT) || 8080);

  console.log("registered all handlers!");
})();
