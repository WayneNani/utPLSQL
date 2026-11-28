create or replace noneditionable type body ut_test as
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

  constructor function ut_test(
    self in out nocopy ut_test, a_object_owner varchar2 := null, a_object_name varchar2, a_name varchar2,
    a_line_no integer, a_expected_error_codes ut_varchar2_rows := null, a_tags ut_varchar2_rows := null
  ) return self as result is
  begin
    self.self_type := $$plsql_unit;
    self.init(a_object_owner, a_object_name, a_name, a_line_no);
    self.item := ut_executable_test(a_object_owner, a_object_name, a_name, ut_utils.gc_test_execute);
    self.before_each_list     := ut_executables();
    self.before_test_list     := ut_executables();
    self.after_test_list      := ut_executables();
    self.after_each_list      := ut_executables();
    self.all_expectations     := ut_expectation_results();
    self.failed_expectations  := ut_expectation_results();
    self.expected_error_codes := a_expected_error_codes;
    self.tags                 := coalesce(a_tags,ut_varchar2_rows());
    return;
  end;

  overriding member procedure mark_as_skipped(self in out nocopy ut_test, a_skip_reason in varchar2) is
  begin
    ut_event_manager.trigger_event(ut_event_manager.gc_before_test, self);
    self.start_time := current_timestamp;
    self.result := ut_utils.gc_disabled;
    self.disabled_reason := coalesce(a_skip_reason,self.disabled_reason);
    ut_utils.debug_log('ut_test.execute - disabled');
    self.results_count.set_counter_values(self.result);
    self.end_time := self.start_time;
    ut_event_manager.trigger_event(ut_event_manager.gc_after_test, self);
  end;

  overriding member function do_execute(self in out nocopy ut_test) return boolean is
    l_no_errors boolean;
    l_savepoint varchar2(30);
  begin

    ut_utils.debug_log('ut_test.execute');

    if self.get_disabled_flag() then
      mark_as_skipped(self.disabled_reason);
    else
      self.start_time := current_timestamp;
      ut_event_manager.trigger_event(ut_event_manager.gc_before_test, self);

      l_savepoint := self.create_savepoint_if_needed();

      --includes listener calls for before and after actions
      l_no_errors := true;
      for i in 1 .. self.before_each_list.count loop
        l_no_errors := self.before_each_list(i).do_execute(self);
        exit when not l_no_errors;
      end loop;

      if l_no_errors then
        for i in 1 .. self.before_test_list.count loop
          l_no_errors := self.before_test_list(i).do_execute(self);
          exit when not l_no_errors;
        end loop;

        if l_no_errors then
          -- execute the test
          self.item.do_execute(self, self.expected_error_codes);

        end if;
        -- perform cleanup regardless of the test or setup failure
        for i in 1 .. self.after_test_list.count loop
          self.after_test_list(i).do_execute(self);
        end loop;
      end if;

      for i in 1 .. self.after_each_list.count loop
        self.after_each_list(i).do_execute(self);
      end loop;
      self.rollback_to_savepoint(l_savepoint);

      self.calc_execution_result();
      self.end_time := current_timestamp;
      ut_event_manager.trigger_event(ut_event_manager.gc_after_test, self);
    end if;
    return l_no_errors;
  end;

  overriding member procedure calc_execution_result(self in out nocopy ut_test) is
    l_warnings ut_varchar2_rows;
  begin
    if self.get_error_stack_traces().count = 0 then
      self.result := ut_expectation_processor.get_status();
    else
      self.result := ut_utils.gc_error;
    end if;
    --expectation results need to be part of test results
    self.all_expectations    := ut_expectation_processor.get_all_expectations();
    self.failed_expectations := ut_expectation_processor.get_failed_expectations();
    l_warnings := coalesce( ut_expectation_processor.get_warnings(), ut_varchar2_rows() );
    self.warnings := self.warnings multiset union all l_warnings;
    self.results_count.increase_warning_count( cardinality(l_warnings) );
    self.results_count.set_counter_values(self.result);
    ut_expectation_processor.clear_expectations();
  end;

  overriding member procedure mark_as_errored(self in out nocopy ut_test, a_error_stack_trace varchar2) is
  begin
    ut_utils.debug_log('ut_test.fail');
    ut_event_manager.trigger_event(ut_event_manager.gc_before_test, self);
    self.start_time := current_timestamp;
    self.parent_error_stack_trace := a_error_stack_trace;
    self.calc_execution_result();
    self.end_time := self.start_time;
    ut_event_manager.trigger_event(ut_event_manager.gc_after_test, self);
  end;

  overriding member function get_error_stack_traces(self ut_test) return ut_varchar2_list is
    l_stack_traces ut_varchar2_list := ut_varchar2_list();
  begin
    ut_utils.append_to_list(l_stack_traces, self.parent_error_stack_trace);
    for i in 1 .. before_each_list.count loop
      ut_utils.append_to_list(l_stack_traces, self.before_each_list(i).get_error_stack_trace());
    end loop;
    for i in 1 .. before_test_list.count loop
      ut_utils.append_to_list(l_stack_traces, self.before_test_list(i).get_error_stack_trace());
    end loop;
    ut_utils.append_to_list(l_stack_traces, self.item.get_error_stack_trace());
    for i in 1 .. after_test_list.count loop
      ut_utils.append_to_list(l_stack_traces, self.after_test_list(i).get_error_stack_trace());
    end loop;
    for i in 1 .. after_each_list.count loop
      ut_utils.append_to_list(l_stack_traces, self.after_each_list(i).get_error_stack_trace());
    end loop;
    return l_stack_traces;
  end;
  overriding member function get_serveroutputs return clob is
    l_outputs clob;
  begin
    for i in 1 .. before_each_list.count loop
      ut_utils.append_to_clob(l_outputs, self.before_each_list(i).serveroutput);
    end loop;
    for i in 1 .. before_test_list.count loop
      ut_utils.append_to_clob(l_outputs, self.before_test_list(i).serveroutput);
    end loop;
    ut_utils.append_to_clob(l_outputs, self.item.serveroutput );
    for i in 1 .. after_test_list.count loop
      ut_utils.append_to_clob(l_outputs, self.after_test_list(i).serveroutput);
    end loop;
    for i in 1 .. after_each_list.count loop
      ut_utils.append_to_clob(l_outputs, self.after_each_list(i).serveroutput);
    end loop;
    return l_outputs;
  end;

  member function get_failed_expectation_lines return ut_varchar2_rows is
    l_results ut_varchar2_rows;
  begin
    for i in 1 .. failed_expectations.count loop
      ut_utils.append_to_list( l_results, ut_utils.convert_collection( failed_expectations(i).get_result_lines() ) );
      ut_utils.append_to_list( l_results, failed_expectations(i).caller_info );
    end loop;
    return l_results;
  end;

  overriding member function has_test_case_source(self in ut_test) return boolean is
  begin
    return self.item.call_source is not null and self.item.call_source_row is null;
  end;

  member function get_source_test_cases(self in ut_test) return ut_suite_items is
    l_parts         ut_varchar2_list := ut_utils.string_to_table(upper(self.item.call_source), '.');
    l_owner         varchar2(128 char);
    l_package       varchar2(128 char);
    l_function      varchar2(128 char);
    l_function_call varchar2(1000 char);
    l_return_type   ut_metadata.t_parameter;
    l_parameters    ut_metadata.tt_parameters;
    l_names         ut_varchar2_list := ut_varchar2_list();
    l_json          clob;
    l_array         json_array_t;
    l_test          ut_test;
    l_result        ut_suite_items := ut_suite_items();

    procedure raise_invalid(a_message varchar2) is
    begin
      raise_application_error(
        ut_utils.gc_invalid_test_case_source, 'The --%testcasesource function ' || self.item.call_source || ' ' || a_message || '.'
      );
    end;
  begin
    case l_parts.count
      when 1 then
        l_owner := upper(self.item.owner_name);
        l_package := upper(self.item.object_name);
        l_function := l_parts(1);
      when 2 then
        l_owner := upper(self.item.owner_name);
        l_package := l_parts(1);
        l_function := l_parts(2);
      else
        l_owner := l_parts(1);
        l_package := l_parts(2);
        l_function := l_parts(3);
    end case;
    l_function_call :=
      dbms_assert.enquote_name(l_owner, false) || '.' || dbms_assert.enquote_name(l_package, false) || '.'
      || dbms_assert.enquote_name(l_function, false) || '()';
    l_return_type := ut_metadata.get_function_return_type(l_owner, l_package, l_function);
    if l_return_type.data_type is null then
      raise_invalid('doesn''t exist or can''t be called without arguments');
    elsif not (l_return_type.data_type = 'OBJECT' and l_return_type.type_name = 'JSON_ARRAY_T') then
      -- json_array_t rather than text or a cursor, so that what the function returns is a JSON array (#1326)
      raise_invalid('must return json_array_t, not ' || nvl(l_return_type.type_name, l_return_type.data_type));
    end if;

    execute immediate
      'declare l_ut_cases json_array_t := ' || l_function_call || ';' ||
      ' begin if l_ut_cases is not null then :ut_json := l_ut_cases.to_clob(); else :ut_json := null; end if; end;'
      using out l_json;
    -- a function that returns null has no test cases
    if l_json is null then
      return l_result;
    end if;

    l_parameters :=
      ut_metadata.get_package_parameters(upper(self.item.owner_name), upper(self.item.object_name), upper(self.item.procedure_name));
    for i in 1 .. l_parameters.count loop
      if l_parameters(i).overload = l_parameters(1).overload and l_parameters(i).parameter_name is not null then
        l_names.extend;
        l_names(l_names.last) := l_parameters(i).parameter_name;
      end if;
    end loop;
    -- each element is a test case, also one that is no JSON array or object: it errors when it runs;
    -- its JSON text is converted to the parameter types when the test case runs
    l_array := json_array_t.parse(l_json);
    for i in 0 .. l_array.get_size - 1 loop
      l_json := l_array.get(i).to_clob;
      l_test := self;
      l_test.name := self.name || '[' || (i + 1) || ']';
      l_test.path := self.path || '[' || (i + 1) || ']';
      l_test.description := ut_test_case_json.get_test_case_description(self.description, l_json, l_names);
      l_test.item.call_source_row := i + 1;
      ut_test_case_values.set_json(l_test.path, l_json);
      l_result.extend;
      l_result(l_result.last) := l_test;
    end loop;
    return l_result;
  end;
end;
/
