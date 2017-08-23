/**
 * @ngdoc function
 * @name superProductivity.controller:JiraAssignTicketCtrl
 * @description
 * # JiraAssignTicketCtrl
 * Controller of the superProductivity
 */

(function () {
  'use strict';

  angular
    .module('superProductivity')
    .controller('JiraAssignTicketCtrl', JiraAssignTicketCtrl);

  /* @ngInject */
  function JiraAssignTicketCtrl($mdDialog, task, theme, Jira, $localStorage) {
    let vm = this;

    vm.theme = theme;
    vm.task = task;

    vm.assignTicket = () => {
      let username = $localStorage.jiraSettings.useInternalName ? $localStorage.jiraSettings.internalName : $localStorage.jiraSettings.userName;
      Jira.updateAssignee(task, username)
        .then($mdDialog.hide, $mdDialog.cancel);
      $mdDialog.hide();
    };

    vm.cancel = () => {
      $mdDialog.cancel();
    };
  }
})();
