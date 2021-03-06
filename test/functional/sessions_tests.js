'use strict';
const expect = require('chai').expect;
const setupDatabase = require('./shared').setupDatabase;
const path = require('path');
const TestRunnerContext = require('./spec-runner').TestRunnerContext;
const gatherTestSuites = require('./spec-runner').gatherTestSuites;
const generateTopologyTests = require('./spec-runner').generateTopologyTests;

const ignoredCommands = ['ismaster'];
const test = {
  commands: { started: [], succeeded: [] },
  setup: function(config) {
    this.commands = { started: [], succeeded: [] };
    this.client = config.newClient(
      { w: 1 },
      { poolSize: 1, auto_reconnect: false, monitorCommands: true }
    );

    this.client.on('commandStarted', event => {
      if (ignoredCommands.indexOf(event.commandName) === -1) {
        this.commands.started.push(event);
      }
    });

    this.client.on('commandSucceeded', event => {
      if (ignoredCommands.indexOf(event.commandName) === -1) {
        this.commands.succeeded.push(event);
      }
    });

    return this.client.connect();
  }
};

describe('Sessions', function() {
  before(function() {
    return setupDatabase(this.configuration);
  });

  describe('endSessions', function() {
    beforeEach(function() {
      return test.setup(this.configuration);
    });

    it('should send endSessions for multiple sessions', {
      metadata: {
        requires: { topology: ['single'], mongodb: '>3.6.0' },
        // Skipping session leak tests b/c these are explicit sessions
        sessions: { skipLeakTests: true }
      },
      test: function(done) {
        const client = test.client;
        let sessions = [client.startSession(), client.startSession()].map(s => s.id);

        client.close(err => {
          expect(err).to.not.exist;
          expect(test.commands.started).to.have.length(1);
          expect(test.commands.started[0].commandName).to.equal('endSessions');
          expect(test.commands.started[0].command.endSessions).to.include.deep.members(sessions);
          expect(client.s.sessions.size).to.equal(0);

          done();
        });
      }
    });
  });

  describe('withSession', {
    metadata: { requires: { mongodb: '>3.6.0' } },
    test: function() {
      beforeEach(function() {
        return test.setup(this.configuration);
      });

      [
        {
          description: 'should support operations that return promises',
          operation: client => session => {
            return client
              .db('test')
              .collection('foo')
              .find({}, { session })
              .toArray();
          }
        },
        // {
        //   nodeVersion: '>=8.x',
        //   description: 'should support async operations',
        //   operation: client => session =>
        //     async function() {
        //       await client
        //         .db('test')
        //         .collection('foo')
        //         .find({}, { session })
        //         .toArray();
        //     }
        // },
        {
          description: 'should support operations that return rejected promises',
          operation: (/* client */) => (/* session */) => {
            return Promise.reject(new Error('something awful'));
          }
        },
        {
          description: "should support operations that don't return promises",
          operation: (/* client */) => (/* session */) => {
            setTimeout(() => {});
          }
        },
        {
          description: 'should support operations that throw exceptions',
          operation: (/* client */) => (/* session */) => {
            throw new Error('something went wrong!');
          }
        }
      ].forEach(testCase => {
        it(testCase.description, function() {
          const client = test.client;

          return client
            .withSession(testCase.operation(client))
            .catch(() => expect(client.topology.s.sessionPool.sessions).to.have.length(1))
            .then(() => expect(client.topology.s.sessionPool.sessions).to.have.length(1))
            .then(() => client.close())
            .then(() => {
              // verify that the `endSessions` command was sent
              const lastCommand = test.commands.started[test.commands.started.length - 1];
              expect(lastCommand.commandName).to.equal('endSessions');
              expect(client.topology.s.sessionPool.sessions).to.have.length(0);
            });
        });
      });

      it('supports passing options to ClientSession', function() {
        const client = test.client;

        const promise = client.withSession({ causalConsistency: false }, session => {
          expect(session.supports.causalConsistency).to.be.false;
          return client
            .db('test')
            .collection('foo')
            .find({}, { session })
            .toArray();
        });

        return promise
          .then(() => expect(client.topology.s.sessionPool.sessions).to.have.length(1))
          .then(() => client.close())
          .then(() => {
            // verify that the `endSessions` command was sent
            const lastCommand = test.commands.started[test.commands.started.length - 1];
            expect(lastCommand.commandName).to.equal('endSessions');
            expect(client.topology.s.sessionPool.sessions).to.have.length(0);
          });
      });
    }
  });

  describe('spec tests', function() {
    class SessionSpecTestContext extends TestRunnerContext {
      assertSessionNotDirty(options) {
        const session = options.session;
        expect(session.serverSession.isDirty).to.be.false;
      }

      assertSessionDirty(options) {
        const session = options.session;
        expect(session.serverSession.isDirty).to.be.true;
      }

      assertSameLsidOnLastTwoCommands() {
        expect(this.commandEvents).to.have.length.of.at.least(2);
        const lastTwoCommands = this.commandEvents.slice(-2).map(c => c.command);
        lastTwoCommands.forEach(command => expect(command).to.have.property('lsid'));
        expect(lastTwoCommands[0].lsid).to.eql(lastTwoCommands[1].lsid);
      }

      assertDifferentLsidOnLastTwoCommands() {
        expect(this.commandEvents).to.have.length.of.at.least(2);
        const lastTwoCommands = this.commandEvents.slice(-2).map(c => c.command);
        lastTwoCommands.forEach(command => expect(command).to.have.property('lsid'));
        expect(lastTwoCommands[0].lsid).to.not.eql(lastTwoCommands[1].lsid);
      }
    }

    const testContext = new SessionSpecTestContext();
    const testSuites = gatherTestSuites(path.join(__dirname, 'spec', 'sessions'));

    after(() => testContext.teardown());
    before(function() {
      if (!this.configuration.usingUnifiedTopology()) {
        this.test.parent.pending = true; // https://github.com/mochajs/mocha/issues/2683
        this.skip();
        return;
      }
      return testContext.setup(this.configuration);
    });

    function testFilter(spec) {
      const SKIP_TESTS = [
        // These two tests need to run against multiple mongoses
        'Dirty explicit session is discarded',
        'Dirty implicit session is discarded (write)'
      ];

      return SKIP_TESTS.indexOf(spec.description) === -1;
    }

    generateTopologyTests(testSuites, testContext, testFilter);
  });
});
