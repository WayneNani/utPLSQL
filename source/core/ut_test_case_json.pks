create or replace noneditionable package ut_test_case_json authid current_user as
  /*
  utPLSQL - Version 3
  Copyright 2016 - 2026 utPLSQL Project

  Licensed under the Apache License, Version 2.0 (the "License").
  You may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
  */

  /**
   * Test cases given as JSON, by --%testcase or by a --%testcasesource function:
   * a JSON array passes its values by position, a JSON object passes its values to the parameters named like its keys.
   */

  /**
   * Returns true when the arguments of a --%testcase annotation are JSON rather than a PL/SQL argument list.
   */
  function is_json(a_arguments varchar2) return boolean;

  /**
   * Returns the reason why a JSON text can't be the arguments of a test case, or null when it can.
   */
  function get_json_error(a_json clob) return varchar2;

  /**
   * Returns an argument list with the same number of positional arguments or the same parameter names as a JSON test case,
   * so that it can be checked against the parameters of the procedure like a PL/SQL argument list.
   */
  function get_arguments_text(a_json clob) return varchar2;

  /**
   * Returns the description of a JSON test case, with the values of the test case filled in (see ut_utils.get_test_case_description).
   */
  function get_test_case_description(a_description varchar2, a_json clob) return varchar2;

  /**
   * Returns a PL/SQL block that calls the procedure with the values of a JSON test case, converted to the types of its parameters.
   * The block expects the JSON text as bind variable :ut_json.
   */
  function get_call(a_owner varchar2, a_package varchar2, a_procedure varchar2, a_call_name varchar2, a_json clob) return varchar2;

end;
/
