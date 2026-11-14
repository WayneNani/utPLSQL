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

  member function has_test_case_source(self in ut_test) return boolean is
  begin
    return self.item.call_source is not null and instr(self.name, '[') = 0;
  end;

  member function get_source_test_cases(self in ut_test) return ut_suite_items is
    -- rownum numbers the rows in the order the query returns them; each test case selects its row by that number
    c_rows_query constant varchar2(32767) :=
      'select ut_q.*, rownum ut_test_case_row from (' || self.item.call_source || ') ut_q';
    l_parameters ut_metadata.tt_parameters :=
      ut_metadata.get_package_parameters(upper(self.item.owner_name), upper(self.item.object_name));
    l_result     ut_suite_items := ut_suite_items();
    l_cursor     integer;
    l_status     integer;
    l_columns    dbms_sql.desc_tab3;
    l_count      integer;
    l_named      boolean := false;
    l_arguments  varchar2(4000);
    l_select     varchar2(32767);
    l_values     ut_varchar2_list;
    l_value      varchar2(4000);
    l_test       ut_test;
    l_row_no     integer := 0;

    function is_parameter(a_column_name varchar2) return boolean is
    begin
      for i in 1 .. l_parameters.count loop
        if l_parameters(i).procedure_name = upper(self.item.procedure_name)
          and l_parameters(i).parameter_name = a_column_name then
          return true;
        end if;
      end loop;
      return false;
    end;

    function display_expression(a_column dbms_sql.desc_rec3) return varchar2 is
      l_column varchar2(200) := 'ut_r."' || a_column.col_name || '"';
    begin
      return
        case
          when a_column.col_type in (1, 2, 12, 96, 100, 101, 180, 181, 182, 183, 231) then 'to_char(' || l_column || ')'
          when a_column.col_type = 112 then 'dbms_lob.substr(' || l_column || ', 100)'
          when a_column.col_type = 252 then 'case when ' || l_column || ' then ''true'' when not ' || l_column || ' then ''false'' end'
          else '''<' || nvl(a_column.col_type_name, 'value') || '>'''
        end;
    end;

    function get_description(a_values ut_varchar2_list) return varchar2 is
      l_description varchar2(32767) := self.description;
    begin
      if regexp_like(self.description, '\{[[:alnum:]_$#]+\}') then
        for i in 1 .. a_values.count loop
          l_description := replace(l_description, '{' || i || '}', a_values(i));
          l_description := replace(l_description, '{' || l_columns(i).col_name || '}', a_values(i));
          l_description := replace(l_description, '{' || lower(l_columns(i).col_name) || '}', a_values(i));
        end loop;
      else
        for i in 1 .. a_values.count loop
          l_description := l_description || case when i = 1 then ' (' else ', ' end || a_values(i);
        end loop;
        l_description := l_description || case when a_values.count > 0 then ')' end;
      end if;
      return substr(l_description, 1, 4000);
    end;
  begin
    l_cursor := dbms_sql.open_cursor;
    begin
      dbms_sql.parse(l_cursor, 'select * from (' || self.item.call_source || ')', dbms_sql.native);
      dbms_sql.describe_columns3(l_cursor, l_count, l_columns);
      -- columns named like parameters are passed by name, otherwise all columns are passed by position
      for i in 1 .. l_count loop
        l_named := l_named or is_parameter(l_columns(i).col_name);
      end loop;
      for i in 1 .. l_count loop
        if not l_named or is_parameter(l_columns(i).col_name) then
          l_arguments := l_arguments || case when l_arguments is not null then ', ' end
            || case when l_named then '"' || l_columns(i).col_name || '" => ' end || 'r."' || l_columns(i).col_name || '"';
        end if;
        l_select := l_select || case when i > 1 then ', ' end || display_expression(l_columns(i));
      end loop;

      dbms_sql.parse(
        l_cursor, 'select ' || l_select || ' from (' || c_rows_query || ') ut_r order by ut_r.ut_test_case_row', dbms_sql.native
      );
      for i in 1 .. l_count loop
        dbms_sql.define_column(l_cursor, i, l_value, 4000);
      end loop;
      l_status := dbms_sql.execute(l_cursor);
      while dbms_sql.fetch_rows(l_cursor) > 0 loop
        l_row_no := l_row_no + 1;
        l_values := ut_varchar2_list();
        for i in 1 .. l_count loop
          dbms_sql.column_value(l_cursor, i, l_value);
          l_values.extend;
          l_values(i) := nvl(l_value, 'null');
        end loop;
        l_test := self;
        l_test.name := self.name || '[' || l_row_no || ']';
        l_test.path := self.path || '[' || l_row_no || ']';
        l_test.description := get_description(l_values);
        l_test.item.call_source := 'select * from (' || c_rows_query || ') where ut_test_case_row = ' || l_row_no;
        l_test.item.call_arguments := l_arguments;
        l_result.extend;
        l_result(l_result.last) := l_test;
      end loop;
      dbms_sql.close_cursor(l_cursor);
    exception
      when others then
        if dbms_sql.is_open(l_cursor) then
          dbms_sql.close_cursor(l_cursor);
        end if;
        raise;
    end;
    return l_result;
  end;
end;
/
