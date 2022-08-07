import { Server, Socket } from "socket.io";
import { prisma } from "./prisma/client";
import superjson from "superjson";
import { FoodieGroup } from "@prisma/client";
import { GroupUserState } from "./types";
import { createServer } from "http";

const httpServer = createServer();

const io = new Server(httpServer, {
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
  console.log({ foodieGroupMap, foodieGroupId });
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
  console.log(m);

  io.on("connection", (socket: Socket) => {
    socket.on("user:first:render", (foodieGroupId) => {
      const foodieGroupMap: Map<string, object> | undefined =
        m.get(foodieGroupId);

      console.log({ foodieGroupMap });

      socket.join(foodieGroupId);
      socket.emit("server:first:render", superjson.stringify(foodieGroupMap));
    });

    socket.on(
      "user:invite:sent",
      async (from, to, foodieGroupId, fromUserState: GroupUserState) => {
        // create room on first group invite sent
        console.log("received user:invite:sent", {
          from,
          to,
          foodieGroupId,
          fromUserState,
        });

        // send to all users ever unfortunately
        // TODO: associate socket with session
        io.emit("server:invite:sent", from, to, foodieGroupId);
        socket.join(foodieGroupId);

        // if it is the first invite, the sender sends its user state also
        if (!m.has(foodieGroupId)) {
          m.set(
            foodieGroupId,
            new Map([
              [from, fromUserState],
              [to, { isInviteAccepted: false, restaurants: [] }],
            ])
          );
        } else {
          m.get(foodieGroupId).set(to, {
            isInviteAccepted: false,
            restaurants: [],
          });
        }
        await persistStateChangeAsync(m.get(foodieGroupId), foodieGroupId);

        console.log("map after invite sent", m);
      }
    );

    socket.on(
      "user:invite:accepted",
      async (name, foodieGroupId, userState) => {
        // add socket which accepted the invite to the room
        socket.join(foodieGroupId);

        // update group state so that we can render RT updates
        const foodieGroupMap: Map<string, GroupUserState> | undefined =
          m.get(foodieGroupId);
        if (!foodieGroupMap) return;

        foodieGroupMap.set(name, userState);
        await persistStateChangeAsync(foodieGroupMap, foodieGroupId);

        // TODO: Create here the foodieGroup in the DB, not from the next.js

        // we do this foreach because we want to send the invited user all group user states
        foodieGroupMap.forEach((userState, name) => {
          io.to(foodieGroupId).emit(
            "server:state:updated",
            superjson.stringify(userState),
            name
          );
        });
      }
    );

    socket.on("user:invite:refused", async (name, foodieGroupId) => {
      // add socket which accepted the invite to the room

      console.log("received user:invite:refused", {
        name,
        foodieGroupId,
      });

      // update group state so that we can render RT updates
      const foodieGroupMap: Map<string, GroupUserState> | undefined =
        m.get(foodieGroupId);
      if (!foodieGroupMap) return;

      foodieGroupMap.delete(name);

      // should be === 1 but you never know
      if (foodieGroupMap.size === 1) {
        m.delete(foodieGroupId);
      } else {
        await persistStateChangeAsync(foodieGroupMap, foodieGroupId);

        // TODO: Create here the foodieGroup in the DB, not from the next.js
      }

      io.to(foodieGroupId).emit(
        "server:state:updated",
        superjson.stringify(undefined),
        name
      );
    });

    socket.on(
      "user:state:updated",
      async (name, foodieGroupId, userState: GroupUserState | undefined) => {
        console.log("received user:state:updated event", {
          name,
          foodieGroupId,
          userState,
        });

        console.log(m);
        // update group state so that we can render RT updates
        if (!m.get(foodieGroupId)) {
          console.log(`user ${name} does not exist on FG ${foodieGroupId}`);
          // TODO: remove this, it should theoretically exist already
          m.set(foodieGroupId, new Map());
        }
        const foodieGroupMap: Map<string, GroupUserState> | undefined =
          m.get(foodieGroupId);

        let isOnlyOneLeft = false;
        // if userState comes undefined, it means it either left the group or signed-out
        if (!userState) {
          socket.leave(foodieGroupId);
          foodieGroupMap.delete(name);
          console.log("after delete name", { foodieGroupMap });

          // if there is only one more member in the foodieGroup after another user left, delete the foodieGroup from the in-memory map
          if (foodieGroupMap.size === 1) {
            isOnlyOneLeft = true;
            m.delete(foodieGroupId);
            console.log("after delete foodiegroup", { m });
          }
        } else {
          foodieGroupMap.set(name, userState);
        }

        if (!isOnlyOneLeft) {
          // the foodieGroup from the DB is deleted through TRPC from Next.js app in this case
          await persistStateChangeAsync(foodieGroupMap, foodieGroupId);
        }

        console.log(m);

        console.log("emit server:state:updated", [
          superjson.stringify(foodieGroupMap.get(name)),
          name,
        ]);

        io.to(foodieGroupId).emit(
          "server:state:updated",
          superjson.stringify(userState),
          name
        );
      }
    );
  });

  httpServer.listen(parseInt(process.env.PORT) || 8080);

  console.log("registered all handlers!");
})();
