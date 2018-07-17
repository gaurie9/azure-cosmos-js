import * as assert from "assert";
import * as sinon from "sinon";
import { Base, Constants, CosmosClient, IHeaders } from "../../";
import { ConsistencyLevel, PartitionKind } from "../../documents";
import testConfig from "./../common/_testConfig";
import { getTestDatabase, removeAllDatabases } from "./../common/TestHelpers";

const endpoint = testConfig.host;
const masterKey = testConfig.masterKey;

// TODO: there is alot of "any" types for tokens here
// TODO: there is alot of leaky document client stuff here that will make removing document client hard

const client = new CosmosClient({
  endpoint,
  auth: { masterKey },
  consistencyLevel: ConsistencyLevel.Session
});

describe("Session Token", function() {
  this.timeout(process.env.MOCHA_TIMEOUT || 20000);

  const containerId = "sessionTestColl";

  const containerDefinition = {
    id: containerId,
    partitionKey: { paths: ["/id"], kind: PartitionKind.Hash }
  };
  const containerOptions = { offerThroughput: 10100 };

  const getSpy = sinon.spy(client.documentClient, "get");
  const postSpy = sinon.spy(client.documentClient, "post");
  const putSpy = sinon.spy(client.documentClient, "put");
  const deleteSpy = sinon.spy(client.documentClient, "delete");

  const getToken = function(tokens: any) {
    const newToken: any = {};
    for (const coll in tokens) {
      if (tokens.hasOwnProperty(coll)) {
        for (const k in tokens[coll]) {
          if (tokens[coll].hasOwnProperty(k)) {
            newToken[k] = tokens[coll][k];
          }
        }
        return newToken;
      }
    }
  };

  const getIndex = function(tokens: any, index1?: any) {
    const keys = Object.keys(tokens);
    if (typeof index1 === "undefined") {
      return keys[0];
    } else {
      return keys[1];
    }
  };

  beforeEach(async function() {
    await removeAllDatabases(client);
  });

  it("validate session tokens for sequence of opearations", async function() {
    let index1;
    let index2;

    const { id: databaseId } = await getTestDatabase(client, "session test");
    const database = client.database(databaseId);

    const createdContainerDef = await database.containers.create(containerDefinition, containerOptions);
    const container = database.container(createdContainerDef.id);
    assert.equal(postSpy.lastCall.args[3][Constants.HttpHeaders.SessionToken], undefined);
    // TODO: testing implementation detail by looking at containerResourceIdToSesssionTokens
    assert.deepEqual(client.documentClient.sessionContainer.collectionResourceIdToSessionTokens, {});

    const { body: document1 } = await container.items.create({ id: "1" });
    assert.equal(postSpy.lastCall.args[3][Constants.HttpHeaders.SessionToken], undefined);

    let tokens = getToken(client.documentClient.sessionContainer.collectionResourceIdToSessionTokens);
    index1 = getIndex(tokens);
    assert.notEqual(tokens[index1], undefined);
    let firstPartitionLSN = tokens[index1];

    const { body: document2 } = await container.items.create({ id: "2" });
    assert.equal(
      postSpy.lastCall.args[3][Constants.HttpHeaders.SessionToken],
      client.documentClient.sessionContainer.getCombinedSessionToken(tokens)
    );

    tokens = getToken(client.documentClient.sessionContainer.collectionResourceIdToSessionTokens);
    index2 = getIndex(tokens, index1);
    assert.equal(tokens[index1], firstPartitionLSN);
    assert.notEqual(tokens[index2], undefined);
    let secondPartitionLSN = tokens[index2];

    await container.item(document1.id, "1").read();

    assert.equal(
      getSpy.lastCall.args[2][Constants.HttpHeaders.SessionToken],
      client.documentClient.sessionContainer.getCombinedSessionToken(tokens)
    );
    tokens = getToken(client.documentClient.sessionContainer.collectionResourceIdToSessionTokens);
    assert.equal(tokens[index1], firstPartitionLSN);
    assert.equal(tokens[index2], secondPartitionLSN);

    const { body: document13 } = await container.items.upsert({ id: "1", operation: "upsert" }, { partitionKey: "1" });
    assert.equal(
      postSpy.lastCall.args[3][Constants.HttpHeaders.SessionToken],
      client.documentClient.sessionContainer.getCombinedSessionToken(tokens)
    );
    tokens = getToken(client.documentClient.sessionContainer.collectionResourceIdToSessionTokens);
    assert.equal(tokens[index1], (Number(firstPartitionLSN) + 1).toString());
    assert.equal(tokens[index2], secondPartitionLSN);
    firstPartitionLSN = tokens[index1];

    await container.item(document2.id, "2").delete();

    assert.equal(
      deleteSpy.lastCall.args[2][Constants.HttpHeaders.SessionToken],
      client.documentClient.sessionContainer.getCombinedSessionToken(tokens)
    );
    tokens = getToken(client.documentClient.sessionContainer.collectionResourceIdToSessionTokens);
    assert.equal(tokens[index1], firstPartitionLSN);
    assert.equal(tokens[index2], (Number(secondPartitionLSN) + 1).toString());
    secondPartitionLSN = tokens[index2];

    await container.item(document13.id).replace({ id: "1", operation: "replace" }, { partitionKey: "1" });
    assert.equal(
      putSpy.lastCall.args[3][Constants.HttpHeaders.SessionToken],
      client.documentClient.sessionContainer.getCombinedSessionToken(tokens)
    );
    tokens = getToken(client.documentClient.sessionContainer.collectionResourceIdToSessionTokens);
    assert.equal(tokens[index1], (Number(firstPartitionLSN) + 1).toString());
    assert.equal(tokens[index2], secondPartitionLSN);
    firstPartitionLSN = tokens[index1];

    const query = "SELECT * from " + containerId;
    const queryOptions = { partitionKey: "1" };
    const queryIterator = container.items.query(query, queryOptions);

    await queryIterator.toArray();
    assert.equal(
      postSpy.lastCall.args[3][Constants.HttpHeaders.SessionToken],
      client.documentClient.sessionContainer.getCombinedSessionToken(tokens)
    );
    tokens = getToken(client.documentClient.sessionContainer.collectionResourceIdToSessionTokens);
    assert.equal(tokens[index1], firstPartitionLSN);
    assert.equal(tokens[index2], secondPartitionLSN);

    await container.delete();
    assert.equal(
      deleteSpy.lastCall.args[2][Constants.HttpHeaders.SessionToken],
      client.documentClient.sessionContainer.getCombinedSessionToken(tokens)
    );
    assert.deepEqual(client.documentClient.sessionContainer.collectionResourceIdToSessionTokens, {});

    getSpy.restore();
    postSpy.restore();
    deleteSpy.restore();
    putSpy.restore();
  });

  it("validate 'lsn not caught up' error for higher lsn and clearing session token", async function() {
    const { id: databaseId } = await getTestDatabase(client, "session test");

    const containerLink = "dbs/" + databaseId + "/colls/" + containerId;
    const database = client.database(databaseId);
    const increaseLSN = function(oldTokens: any) {
      for (const coll in oldTokens) {
        if (oldTokens.hasOwnProperty(coll)) {
          for (const token in oldTokens[coll]) {
            if (oldTokens[coll].hasOwnProperty(token)) {
              const newVal = (Number(oldTokens[coll][token]) + 2000).toString();
              return token + ":" + newVal;
            }
          }
        }
      }
    };

    await database.containers.create(containerDefinition, containerOptions);
    const container = database.container(containerDefinition.id);
    await container.items.create({ id: "1" });
    const callbackSpy = sinon.spy(function(pat: string, reqHeaders: IHeaders) {
      const oldTokens = client.documentClient.sessionContainer.collectionResourceIdToSessionTokens;
      reqHeaders[Constants.HttpHeaders.SessionToken] = increaseLSN(oldTokens);
    });
    const applySessionTokenStub = sinon.stub(client.documentClient, "applySessionToken").callsFake(callbackSpy);
    try {
      await container.item("1").read({ partitionKey: "1" });
      assert.fail("readDocument must throw");
    } catch (err) {
      assert.equal(err.substatus, 1002, "Substatus should indicate the LSN didn't catchup.");
      assert.equal(callbackSpy.callCount, 1);
      assert.equal(Base._trimSlashes(callbackSpy.lastCall.args[0]), containerLink + "/docs/1");
      applySessionTokenStub.restore();
    }
    await container.item("1").read({ partitionKey: "1" });
  });

  // TODO: chrande - looks like this might be broken by going name based?
  // We never had a name based version of this test. Looks like we fail to set the session token
  // because OwnerId is missing on the header. This only happens for name based.
  it.skip("client should not have session token of a container created by another client", async function() {
    // const client2 = new CosmosClient({
    //   endpoint,
    //   auth: { masterKey },
    //   consistencyLevel: ConsistencyLevel.Session
    // });
    // const { body: databaseDef } = await client.databases.create(databaseBody);
    // const database = client.database(databaseDef.id);
    // await database.containers.create(containerDefinition, containerOptions);
    // const container = database.container(containerDefinition.id);
    // await container.read();
    // await client2
    //   .database(databaseDef.id)
    //   .container(containerDefinition.id)
    //   .delete();
    // await client2.database(databaseDef.id).containers.create(containerDefinition, containerOptions);
    // await client2
    //   .database(databaseDef.id)
    //   .container(containerDefinition.id)
    //   .read();
    // assert.equal(client.documentClient.getSessionToken(container.url), ""); // TODO: _self
    // assert.notEqual(client2.documentClient.getSessionToken(container.url), "");
  });

  it("validate session container update on 'Not found' with 'undefined' status code for non master resource", async function() {
    const client2 = new CosmosClient({
      endpoint,
      auth: { masterKey },
      consistencyLevel: ConsistencyLevel.Session
    });

    const db = await getTestDatabase(client, "session test");

    const createdContainerDef = await db.containers.create(containerDefinition, containerOptions);
    const createdContainer = db.container(createdContainerDef.id);

    const { body: createdDocument } = await createdContainer.items.create({
      id: "1"
    });
    const requestOptions = { partitionKey: "1" };
    await client2
      .database(db.id)
      .container(createdContainerDef.id)
      .item(createdDocument.id)
      .delete(requestOptions);
    const setSessionTokenSpy = sinon.spy(client.documentClient.sessionContainer, "setSessionToken");

    try {
      await createdContainer.item(createdDocument.id).read(requestOptions);
      assert.fail("Must throw");
    } catch (err) {
      assert.equal(err.code, 404, "expecting 404 (Not found)");
      assert.equal(err.substatus, undefined, "expecting substatus code to be undefined");
      assert.equal(setSessionTokenSpy.callCount, 1, "unexpected number of calls to sesSessionToken");
      setSessionTokenSpy.restore();
    }
  });
});