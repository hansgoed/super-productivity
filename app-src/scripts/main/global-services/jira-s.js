/**
 * @ngdoc service
 * @name superProductivity.Jira
 * @description
 * # Jira
 * Service in the superProductivity.
 */

(function () {
  'use strict';

  const IPC_JIRA_CB_EVENT = 'JIRA_RESPONSE';
  const IPC_JIRA_MAKE_REQUEST_EVENT = 'JIRA';

  // it's weird!!
  const JIRA_DATE_FORMAT = 'YYYY-MM-DDTHH:mm:ss.SSZZ';

  const MAX_RESULTS = 100;
  const ISSUE_TYPE = 'JIRA';
  const SUGGESTION_FIELDS_TO_GET = [
    'assignee',
    'summary',
    'description',
    'timeestimate',
    'timespent',
    'status',
    'attachment',
    'comment',
    'updated'
  ];

  /* @ngInject */
  class Jira {
    constructor(IS_ELECTRON, SimpleToast, Uid, $q, $localStorage, Dialogs, Notifier, $injector, $timeout, REQUEST_TIMEOUT, $log, $window) {
      this.requestsLog = {};

      this.IS_ELECTRON = IS_ELECTRON;
      this.Uid = Uid;
      this.$q = $q;
      this.$localStorage = $localStorage;
      this.Dialogs = Dialogs;
      this.Notifier = Notifier;
      this.$injector = $injector;
      this.$timeout = $timeout;
      this.REQUEST_TIMEOUT = REQUEST_TIMEOUT;
      this.$log = $log;
      this.SimpleToast = SimpleToast;
      this.$window = $window;

      // set up callback listener for electron
      if (IS_ELECTRON) {
        const that = this;
        window.ipcRenderer.on(IPC_JIRA_CB_EVENT, (ev, res) => {
          // check if proper id is given in callback and if exists in requestLog
          if (res.requestId && that.requestsLog[res.requestId]) {
            let currentRequest = that.requestsLog[res.requestId];
            // cancel timeout for request
            that.$timeout.cancel(currentRequest.timeout);

            // resolve saved promise
            if (!res || res.error) {
              that.$log.log('FRONTEND_REQUEST', currentRequest);
              that.$log.log('RESPONSE', res);
              that.SimpleToast('ERROR', 'Jira Request failed: ' + currentRequest.clientRequest.apiMethod + ' – ' + (res && res.error));
              currentRequest.defer.reject(res);
            } else {
              currentRequest.defer.resolve(res);
            }
            // delete entry for promise afterwards
            delete that.requestsLog[res.requestId];
          }
        });
      }
    }

    // Helper functions
    // ----------------
    sendRequest(request) {
      // assign uuid to request to know which responsive belongs to which promise
      request.requestId = this.Uid();
      const defer = this.$q.defer();
      // save to request log
      this.requestsLog[request.requestId] = {
        defer,
        requestMethod: request.apiMethod,
        clientRequest: request,
        timeout: this.$timeout(() => {
          this.SimpleToast('ERROR', 'Jira Request timed out for ' + request.apiMethod);
          // delete entry for promise
          delete this.requestsLog[request.requestId];
        }, this.REQUEST_TIMEOUT)
      };

      // send to electron
      window.ipcRenderer.send(IPC_JIRA_MAKE_REQUEST_EVENT, request);

      return defer.promise;
    }

    static mapComments(issue) {
      return issue.fields.comment && issue.fields.comment.comments && issue.fields.comment.comments.map((comment) => {
          return {
            author: comment.author.name,
            body: comment.body
          };
        });
    }

    static mapAttachments(issue) {
      return issue.fields.attachment && issue.fields.attachment.map((attachment) => {
          return attachment.content;
        });
    }

    static mapAndAddChangelogToTask(task, issue) {
      let transformedChangelog;

      if (issue && issue.changelog) {
        transformedChangelog = [];
        let changelog = issue.changelog;
        if (changelog.histories) {
          // we also add 1 seconds because of the millisecond difference
          // for issue updated and historyEntry.created
          let lastUpdate = task.originalUpdated && moment(task.originalUpdated).add(1, 'second');
          for (let i = 0; i < changelog.histories.length; i++) {
            let history = changelog.histories[i];
            let historyCreated = moment(history.created);

            // add if newer than the last update
            if (lastUpdate && historyCreated.isAfter(lastUpdate)) {
              transformedChangelog.push({
                author: history.author.displayName,
                items: history.items,
                created: historyCreated
              });
            }
          }
        }
      }
      task.originalChangelog = transformedChangelog;
      return transformedChangelog;
    }

    static isJiraTask(task) {
      return task && task.originalType === ISSUE_TYPE;
    }

    updateTaskWithIssue(task, issue) {
      const mappedIssue = this.mapIssue(issue);
      _.forOwn(mappedIssue, (val, property) => {
        if (val === null && task.hasOwnProperty(property)) {
          delete task[property];
        } else {
          task[property] = val;
        }
      });
    }

    mapIssue(issue) {
      return {
        title: issue.key + ' ' + issue.fields.summary,
        notes: issue.fields.description,
        originalType: ISSUE_TYPE,
        originalKey: issue.key,
        originalAssigneeKey: issue.fields.assignee && issue.fields.assignee.key.toString(),
        assignee: issue.fields.assignee,
        originalComments: Jira.mapComments(issue),
        originalId: issue.id,
        originalUpdated: issue.fields.updated,
        originalStatus: issue.fields.status,
        originalAttachment: Jira.mapAttachments(issue),
        originalLink: 'https://' + this.$localStorage.jiraSettings.host + '/browse/' + issue.key,
        originalEstimate: issue.fields.timeestimate && moment.duration({
          seconds: issue.fields.timeestimate
        }),
        originalTimeSpent: issue.fields.timespent && moment.duration({
          seconds: issue.fields.timespent
        }),
      };
    }

    isSufficientJiraSettings(settingsToTest) {
      if (!settingsToTest) {
        settingsToTest = this.$localStorage.jiraSettings;
      }
      return settingsToTest && settingsToTest.isJiraEnabled && !!settingsToTest.host && !!settingsToTest.userName && !!settingsToTest.password;
    }

    transformIssues(response) {
      if (response) {
        let res = response.response;
        let tasks = [];

        for (let i = 0; i < res.issues.length; i++) {
          let issue = res.issues[i];
          tasks.push(this.mapIssue(issue));
        }

        return tasks;
      }
    }

    preCheck(task) {
      if (!this.IS_ELECTRON) {
        return this.$q.reject('Jira: Not a in electron context');
      } else if (!this.isSufficientJiraSettings()) {
        return this.$q.reject('Jira: Insufficient settings.');
      } else if (task && !Jira.isJiraTask(task)) {
        this.SimpleToast('ERROR', 'Jira Request failed: Not a real ' + ISSUE_TYPE + ' issue.');
        return this.$q.reject('Jira: Not a real ' + ISSUE_TYPE + ' issue.');
      } else if (!this.$window.navigator.onLine) {
        this.SimpleToast('ERROR', 'Not connected to the Internet.');
        return this.$q.reject('Not connected to the Internet.');
      } else {
        return false;
      }
    }

    setUpdatedToNow(task) {
      task.originalUpdated = moment().format(JIRA_DATE_FORMAT);
    }

    // Simple API Mappings
    // -------------------
    _addWorklog(originalKey, started, timeSpent, comment) {
      if (originalKey && started && started.toISOString && timeSpent && timeSpent.asSeconds) {
        const request = {
          config: this.$localStorage.jiraSettings,
          apiMethod: 'addWorklog',
          arguments: [
            originalKey,
            {
              started: started.format(JIRA_DATE_FORMAT),
              timeSpentSeconds: timeSpent.asSeconds(),
              comment: comment,
            }
          ]
        };
        return this.sendRequest(request);
      } else {
        this.SimpleToast('ERROR', 'Jira: Not enough parameters for worklog.');
        return this.$q.reject('Jira: Not enough parameters for worklog.');
      }
    }

    searchUsers(userNameQuery) {
      const isFailedPreCheck = this.preCheck();
      if (isFailedPreCheck) {
        return isFailedPreCheck;
      }

      const request = {
        config: this.$localStorage.jiraSettings,
        apiMethod: 'searchUsers',
        arguments: [{ username: userNameQuery }]
      };

      return this.sendRequest(request);
    }

    getTransitionsForIssue(task) {
      const isFailedPreCheck = this.preCheck(task);
      if (isFailedPreCheck) {
        return isFailedPreCheck;
      }

      const request = {
        config: this.$localStorage.jiraSettings,
        apiMethod: 'listTransitions',
        arguments: [task.originalKey]
      };
      return this.sendRequest(request);
    }

    getAutoAddedIssues() {
      const defer = this.$q.defer();

      const options = {
        maxResults: MAX_RESULTS,
        fields: SUGGESTION_FIELDS_TO_GET
      };

      if (this.isSufficientJiraSettings() && this.$localStorage.jiraSettings.jqlQueryAutoAdd) {
        const request = {
          config: this.$localStorage.jiraSettings,
          apiMethod: 'searchJira',
          arguments: [this.$localStorage.jiraSettings.jqlQueryAutoAdd, options]
        };
        this.sendRequest(request)
          .then((res) => {
            defer.resolve(this.transformIssues(res));
          }, defer.reject);
      } else {
        this.SimpleToast('ERROR', 'Jira: Insufficient settings. Please define a jqlQuery for auto adding issues');
        defer.reject('Jira: Insufficient settings');
      }

      return defer.promise;
    }

    // Complex Functions
    // -----------------
    updateStatus(task, localType) {
      const isFailedPreCheck = this.preCheck(task);
      if (isFailedPreCheck) {
        return isFailedPreCheck;
      }

      const defer = this.$q.defer();

      const isAutoTransitionAndGotTransitions = this.$localStorage.jiraSettings.transitions && this.$localStorage.jiraSettings.transitions[localType] && this.$localStorage.jiraSettings.transitions[localType] !== 'ALWAYS_ASK';

      if (isAutoTransitionAndGotTransitions) {
        const isNoUpdateTransition = this.$localStorage.jiraSettings.transitions[localType] === 'DO_NOT';
        if (isNoUpdateTransition) {
          defer.reject('DO_NOT chosen');
        } else {

          // check if status needs an update
          if (task.status !== localType) {
            this.transitionIssue(task, {
              id: this.$localStorage.jiraSettings.transitions[localType]
            }, localType)
              .then(defer.resolve, defer.reject);
          } else {
            defer.resolve('NO NEED TO UPDATE');
          }
        }
      } else {
        this.getTransitionsForIssue(task)
          .then((response) => {
            let transitions = response.response.transitions;
            this.Dialogs('JIRA_SET_STATUS', { transitions, task, localType })
              .then((transition) => {
                this.transitionIssue(task, transition, localType)
                  .then(defer.resolve, defer.reject);
              }, defer.reject);
          }, defer.reject);
      }

      return defer.promise;
    }

    updateIssueDescription(task) {
      const isFailedPreCheck = this.preCheck(task);
      if (isFailedPreCheck) {
        return isFailedPreCheck;
      }
      else if (!this.$localStorage.jiraSettings.isUpdateIssueFromLocal) {
        return this.$q.reject('Jira: jiraSettings.isUpdateIssueFromLocal is deactivated');
      }
      else if (!angular.isString(task.notes)) {
        this.SimpleToast('ERROR', 'Jira: Not enough parameters for updateIssueDescription.');
        return this.$q.reject('Jira: Not enough parameters for updateIssueDescription.');
      } else {
        const request = {
          config: this.$localStorage.jiraSettings,
          apiMethod: 'updateIssue',
          arguments: [task.originalKey, {
            fields: {
              description: task.notes
            }
          }]
        };
        return this.sendRequest(request).then(() => {
          // set original update to now to prevent showing this as task update
          this.setUpdatedToNow(task);
          this.SimpleToast('SUCCESS', 'Jira: Description updated for ' + task.originalKey);
        });
      }
    }

    updateAssignee(task, assignee) {
      const isFailedPreCheck = this.preCheck(task);
      if (isFailedPreCheck) {
        return isFailedPreCheck;
      }
      else if (!assignee) {
        this.SimpleToast('ERROR', 'Jira: Not enough parameters for updateAssignee.');
        return this.$q.reject('Jira: Not enough parameters for updateAssignee.');
      } else {
        const request = {
          config: this.$localStorage.jiraSettings,
          apiMethod: 'updateIssue',
          arguments: [task.originalKey, {
            fields: {
              assignee: {
                name: assignee
              }
            }
          }]
        };
        return this.sendRequest(request).then(() => {
          // update local marker
          task.originalAssigneeKey = assignee;
          this.SimpleToast('SUCCESS', 'Jira: Assignee set to "' + assignee + '" for ' + task.originalKey);
        });
      }
    }

    checkUpdatesForTicket(task, isNoNotify) {
      const isFailedPreCheck = this.preCheck(task);
      if (isFailedPreCheck) {
        return isFailedPreCheck;
      }

      const defer = this.$q.defer();
      const request = {
        config: this.$localStorage.jiraSettings,
        apiMethod: 'findIssue',
        arguments: [task.originalKey, 'changelog']
      };
      this.sendRequest(request)
        .then((res) => {
            let issue = res.response;
            // we also add 1 seconds because of the slight delay when updating the database
            let lastUpdate = task.originalUpdated && moment(task.originalUpdated).add(1, 'second');

            if (lastUpdate && moment(issue.fields.updated).isAfter(lastUpdate)) {
              if (!isNoNotify) {
                // add changelog entries
                Jira.mapAndAddChangelogToTask(task, issue);
                task.isUpdated = true;
              }

              // update task with new values
              this.updateTaskWithIssue(task, issue);

              defer.resolve(task);
            } else {
              defer.resolve(false);
            }
          }, defer.reject
        );

      return defer.promise;
    }

    addWorklog(originalTask) {
      const isFailedPreCheck = this.preCheck();
      if (isFailedPreCheck) {
        return isFailedPreCheck;
      }

      const that = this;
      const Tasks = this.$injector.get('Tasks');
      const defer = this.$q.defer();
      let outerTimeSpent;

      // WE'RE always copying the task for add work log
      // so no data should be added back by this call!
      let task = angular.copy(originalTask);
      let comment;

      function successHandler(res) {
        that.SimpleToast('SUCCESS', 'Jira: Updated worklog for ' + task.originalKey + ' by ' + parseInt(outerTimeSpent.asMinutes(), 10) + 'm.');

        // set original update to now to prevent showing this as task update
        that.setUpdatedToNow(task);

        defer.resolve(res);
      }

      if (this.$localStorage.jiraSettings.isWorklogEnabled) {

        // use parent task option if enabled
        if (this.$localStorage.jiraSettings.isAddWorklogOnSubTaskDone) {
          if (task.parentId) {
            let parentTaskCopy = angular.copy(Tasks.getById(task.parentId));
            if (Jira.isJiraTask(parentTaskCopy)) {

              comment = task.title;

              parentTaskCopy.title = parentTaskCopy.originalKey + ': ' + task.title;
              parentTaskCopy.timeSpent = task.timeSpent;
              parentTaskCopy.started = task.started;

              // finally set worklog task to parent
              task = parentTaskCopy;
            }
          }
          // don't execute for tasks with sub tasks in this mode
          else if (task.subTasks && task.subTasks.length > 0) {
            return this.$q.when('Jira Add Worklog: No Update require because we use sub tasks.');
          }
        }

        if (Jira.isJiraTask(task)) {
          this.checkUpdatesForTicket(task)
            .then(() => {
              if (this.$localStorage.jiraSettings.isAutoWorklog) {
                outerTimeSpent = task.timeSpent;
                this._addWorklog(task.originalKey, moment(task.started), task.timeSpent)
                  .then(successHandler, defer.reject);
              } else {
                this.Dialogs('JIRA_ADD_WORKLOG', { task, comment })
                  .then((dialogTaskCopy) => {
                    outerTimeSpent = dialogTaskCopy.timeSpent;
                    this._addWorklog(dialogTaskCopy.originalKey, dialogTaskCopy.started, dialogTaskCopy.timeSpent, dialogTaskCopy.comment)
                      .then(successHandler, defer.reject);
                  }, defer.reject);
              }
            }, defer.reject);
        } else {
          defer.reject('Jira: Task or Parent Task are no Jira Tasks.');
        }
      }

      return defer.promise;
    }

    transitionIssue(task, transitionObj, localType) {
      const isFailedPreCheck = this.preCheck();
      if (isFailedPreCheck) {
        return isFailedPreCheck;
      }

      const defer = this.$q.defer();
      const that = this;

      function transitionSuccess(res) {
        // add name as our transitionObject may only contain the id
        if (!transitionObj.name) {
          transitionObj = _.find(that.$localStorage.jiraSettings.allTransitions, (currentTransObj) => {
            return currentTransObj.id === transitionObj.id;
          });
        }
        // update
        task.status = localType;
        task.originalStatus = transitionObj;

        // set original update to now to prevent showing this as task update
        that.setUpdatedToNow(task);

        that.SimpleToast('SUCCESS', `Jira: Updated task status to "${transitionObj.name}"`);
        defer.resolve(res);
      }

      this.checkUpdatesForTicket(task)
        .then(() => {
          const request = {
            config: this.$localStorage.jiraSettings,
            apiMethod: 'transitionIssue',
            arguments: [task.originalId, {
              transition: {
                id: transitionObj.id
              }
            }]
          };
          this.sendRequest(request)
            .then(transitionSuccess, defer.reject);
        });

      return defer.promise;
    }

    getSuggestions() {
      const isFailedPreCheck = this.preCheck();
      if (isFailedPreCheck) {
        return isFailedPreCheck;
      }

      const options = {
        maxResults: MAX_RESULTS,
        fields: SUGGESTION_FIELDS_TO_GET
      };

      if (this.$localStorage.jiraSettings.jqlQuery) {
        const request = {
          config: this.$localStorage.jiraSettings,
          apiMethod: 'searchJira',
          arguments: [this.$localStorage.jiraSettings.jqlQuery, options]
        };
        return this.sendRequest(request);
      } else {
        this.SimpleToast('ERROR', 'Jira: Insufficient settings. Please define a jqlQuery');
        return this.$q.reject('Jira: Insufficient jqlQuery');
      }
    }

    checkForNewAndAddToBacklog() {
      const Tasks = this.$injector.get('Tasks');

      if (this.isSufficientJiraSettings() && this.$localStorage.jiraSettings.isEnabledAutoAdd) {
        this.getAutoAddedIssues()
          .then((issues) => {
            _.each(issues, (issue) => {
              if (!Tasks.isTaskWithOriginalIdExistant(issue.originalId)) {
                const task = Tasks.createTask(issue);
                // the second param is the updateFromRemote flag
                Tasks.addNewToTopOfBacklog(task, true);
              }
            });
          });
      }
    }

    checkForUpdates(tasks) {
      const TasksUtil = this.$injector.get('TasksUtil');
      const defer = this.$q.defer();

      let tasksToPoll = TasksUtil.flattenTasks(tasks, Jira.isJiraTask, Jira.isJiraTask);
      // execute requests sequentially to have a little more time
      let pollPromise = tasksToPoll.reduce((promise, task) =>
        promise.then(() =>
          this.checkUpdatesForTicket(task)
            .then((isUpdated) => {
              this.taskIsUpdatedHandler(isUpdated, task);
            }, defer.reject)
        ), Promise.resolve()
      );

      pollPromise
        .then(() => {
          defer.resolve();
        });

      return defer.promise;
    }

    taskIsUpdatedHandler(updatedTask, originalTask) {
      if (!originalTask) {
        originalTask = updatedTask;
      }

      // check if the user assigned matches the current user
      if (originalTask && originalTask.originalAssigneeKey && originalTask.originalAssigneeKey !== this.$localStorage.jiraSettings.userName && !originalTask.isDone) {
        const msg = '"' + originalTask.originalKey + '" is assigned to "' + originalTask.originalAssigneeKey + '".';
        this.Notifier({
          title: 'Jira issue ' + originalTask.originalKey + ' is assigned to another user',
          message: msg,
          sound: true,
          wait: true
        });
        this.SimpleToast('WARNING', msg);
      }

      if (updatedTask) {
        const msg = '"' + originalTask.originalKey + '" => has been updated as it was updated on Jira.';
        this.Notifier({
          title: 'Jira Update',
          message: msg,
          sound: true,
          wait: true
        });
        this.SimpleToast('CUSTOM', msg, 'update');
      }
    }

    checkUpdatesForTaskOrParent(task, isNoNotify) {
      let isCallMade = false;
      const Tasks = this.$injector.get('Tasks');
      const defer = this.$q.defer();
      if (task) {
        if (!task.originalKey && task.parentId) {
          let parentTask = Tasks.getById(task.parentId);
          if (parentTask.originalKey) {
            // set task to parent task
            task = parentTask;
          }
        }
        if (Jira.isJiraTask(task)) {
          this.checkUpdatesForTicket(task, isNoNotify)
            .then((updatedTask) => {
              this.taskIsUpdatedHandler(updatedTask, task);
              if (updatedTask) {
                defer.resolve(updatedTask);
              } else {
                defer.resolve(task);
              }
            }, () => {
              // just resolve original
              defer.resolve(task);
            });

          isCallMade = true;
        }
      }

      if (!isCallMade) {
        // just resolve original
        defer.resolve(task);
      }

      return defer.promise;
    }
  }

  // hacky fix for ff
  Jira.$$ngIsClass = true;

  angular
    .module('superProductivity')
    .service('Jira', Jira);
})();
